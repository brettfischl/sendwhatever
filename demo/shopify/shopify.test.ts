import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../src/fingerprint/index.js';
import {
  fixtureSources,
  freshDelivery,
  freshFlow,
  orderFlow,
  productFlow,
  SHOP_DOMAIN,
  SHOPIFY_API_VERSION,
  shopifyFlows,
  type AnyShopifyStep,
} from './index.js';

const allSteps: readonly AnyShopifyStep[] = shopifyFlows.flatMap((flow) => [...flow.steps]);
const [productCreated, productUpdated] = productFlow.steps;
const [orderCreated, orderPaid, refundCreated] = orderFlow.steps;

/** Every value in a body, with its key and the object that holds it. */
function* walk(
  value: unknown,
  key = '',
  parent: Record<string, unknown> = {},
): Generator<{ key: string; value: unknown; parent: Record<string, unknown> }> {
  yield { key, value, parent };
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item, key, parent);
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    for (const [childKey, child] of Object.entries(object)) yield* walk(child, childKey, object);
  }
}

function stringsIn(body: unknown): string[] {
  return [...walk(body)].flatMap(({ value }) => (typeof value === 'string' ? [value] : []));
}

describe('the flows', () => {
  it('play in the order Shopify would send them', () => {
    expect(shopifyFlows.map((flow) => flow.steps.map((step) => step.topic))).toEqual([
      ['products/create', 'products/update'],
      ['orders/create', 'orders/paid', 'refunds/create'],
    ]);
    for (const flow of shopifyFlows) {
      const times = flow.steps.map((step) => Date.parse(step.headers['X-Shopify-Triggered-At']));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(new Set(times).size).toBe(times.length);
    }
  });

  it('give every step what the UI shows, and a source', () => {
    expect(new Set(allSteps.map((step) => step.id)).size).toBe(allSteps.length);
    for (const step of allSteps) {
      expect(step.label).not.toBe('');
      expect(step.description).not.toBe('');
      expect(step.method).toBe('POST');
      expect(step.path).toBe('/ingest/shopify');
      const source = fixtureSources[step.topic];
      expect(source.docUrl).toMatch(/^https:\/\/shopify\.dev\//);
      expect(source.sample).toContain(step.topic);
      expect(source.apiVersion).toBe(SHOPIFY_API_VERSION);
      expect(source.inferred.length).toBeGreaterThan(0);
    }
  });

  it('don\'t put the API key in the path, since the sender adds it', () => {
    for (const step of allSteps) expect(step.path).not.toContain('key=');
  });
});

describe('the product flow', () => {
  it('keeps one product, with its variants, options, and images pointing at it', () => {
    expect(productUpdated.body.id).toBe(productCreated.body.id);
    expect(productUpdated.body.handle).toBe(productCreated.body.handle);
    for (const { body } of productFlow.steps) {
      for (const child of [...body.variants, ...body.options, ...body.images]) {
        expect(child.product_id).toBe(body.id);
      }
      expect(body.image).toEqual(body.images[0]);
      expect(body.variant_gids.map((v) => v.admin_graphql_api_id)).toEqual(
        body.variants.map((v) => v.admin_graphql_api_id),
      );
    }
  });

  it('keeps existing variant and image IDs when updating, and adds new ones', () => {
    const before = productCreated.body;
    const after = productUpdated.body;
    expect(after.variants.slice(0, before.variants.length).map((v) => v.id)).toEqual(
      before.variants.map((v) => v.id),
    );
    expect(after.variants.length).toBeGreaterThan(before.variants.length);
    expect(after.images.slice(0, before.images.length).map((i) => i.id)).toEqual(
      before.images.map((i) => i.id),
    );
    expect(after.images.length).toBeGreaterThan(before.images.length);
  });

  it('only references variants and images that exist', () => {
    const { variants, images, options } = productUpdated.body;
    const imageIds = images.map((image) => image.id);
    const variantIds = variants.map((variant) => variant.id);
    for (const variant of variants) expect(imageIds).toContain(variant.image_id);
    for (const id of images.flatMap((image) => image.variant_ids)) {
      expect(variantIds).toContain(id);
    }
    const sizes = options.find((option) => option.name === 'Size')?.values;
    expect(variants.map((variant) => variant.option1)).toEqual(sizes);
  });
});

describe('the order flow', () => {
  it('keeps the same order, customer, and line items from creation to payment', () => {
    expect(orderPaid.body.id).toBe(orderCreated.body.id);
    expect(orderPaid.body.customer).toEqual(orderCreated.body.customer);
    expect(orderPaid.body.line_items).toEqual(orderCreated.body.line_items);
    expect([orderCreated.body.financial_status, orderPaid.body.financial_status]).toEqual([
      'authorized',
      'paid',
    ]);
    expect(orderPaid.body.total_outstanding).toBe('0.00');
  });

  it('points the refund at the order and at real line items', () => {
    const refund = refundCreated.body;
    expect(refund.order_id).toBe(orderCreated.body.id);
    expect(refund.transactions.map((transaction) => transaction.order_id)).toEqual([
      orderCreated.body.id,
    ]);
    expect(refund.refund_line_items.length).toBeGreaterThan(0);
    for (const refundLine of refund.refund_line_items) {
      const ordered = orderCreated.body.line_items.find(
        (item) => item.id === refundLine.line_item_id,
      );
      expect(ordered).toBeDefined();
      expect(refundLine.line_item.id).toBe(refundLine.line_item_id);
      expect(refundLine.quantity).toBeLessThanOrEqual(ordered?.quantity ?? 0);
      // Same line item as the order's, apart from what the refund itself changed.
      expect({ ...ordered, fulfillable_quantity: 0 }).toMatchObject(refundLine.line_item);
    }
  });

  it('buys variants that the product flow really has', () => {
    const product = productUpdated.body;
    const items = orderCreated.body.line_items;
    const fromProduct = items.filter((item) => item.product_id !== null);
    expect(fromProduct.length).toBeGreaterThan(0);
    for (const item of fromProduct) {
      expect(item.product_id).toBe(product.id);
      const variant = product.variants.find((candidate) => candidate.id === item.variant_id);
      expect(variant?.sku).toBe(item.sku);
      expect(variant?.title).toBe(item.variant_title);
      expect(variant?.price).toBe(item.price);
    }
  });

  it('has money and weights that add up', () => {
    const cents = (amount: string | number) => Math.round(Number(amount) * 100);
    const order = orderCreated.body;
    const lines = order.line_items;
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    expect(sum(lines.map((item) => cents(item.price) * item.quantity))).toBe(
      cents(order.total_line_items_price),
    );
    expect(sum(lines.flatMap((item) => item.tax_lines.map((tax) => cents(tax.price))))).toBe(
      cents(order.total_tax),
    );
    expect(
      cents(order.subtotal_price) +
        cents(order.total_tax) +
        cents(order.total_shipping_price_set.shop_money.amount),
    ).toBe(cents(order.total_price));
    expect(sum(lines.map((item) => item.grams * item.quantity))).toBe(order.total_weight);

    const refund = refundCreated.body;
    const refunded = sum(
      refund.refund_line_items.map((line) => cents(line.subtotal) + cents(line.total_tax)),
    );
    expect(sum(refund.transactions.map((transaction) => cents(transaction.amount)))).toBe(refunded);
    for (const line of refund.refund_line_items) {
      expect(cents(line.subtotal_set.shop_money.amount)).toBe(cents(line.subtotal));
      expect(cents(line.total_tax_set.shop_money.amount)).toBe(cents(line.total_tax));
    }
  });
});

describe('the shapes', () => {
  it('fingerprint as PRD §7 implies: filled-in nulls make a new shape, a status change does not', () => {
    expect(fingerprint(productUpdated.body)).not.toBe(fingerprint(productCreated.body));
    expect(fingerprint(orderPaid.body)).toBe(fingerprint(orderCreated.body));
    expect(fingerprint(refundCreated.body)).not.toBe(fingerprint(orderCreated.body));
  });

  it('keep the same keys across each pair of topics, as Shopify does', () => {
    const keys = (body: object) => Object.keys(body).sort();
    expect(keys(productUpdated.body)).toEqual(keys(productCreated.body));
    expect(keys(orderPaid.body)).toEqual(keys(orderCreated.body));
  });

  it('have the realistic oddities the LLM should have to deal with', () => {
    const line = refundCreated.body.refund_line_items[0];
    expect(typeof line?.subtotal).toBe('number');
    expect(typeof line?.subtotal_set.shop_money.amount).toBe('string');
    expect(typeof productCreated.body.tags).toBe('string');
    expect(productCreated.body.published_at).toBeNull();
    expect(orderCreated.body.line_items.some((item) => item.product_id === null)).toBe(true);
  });
});

describe('the numeric IDs', () => {
  const idEntries = allSteps.flatMap((step) =>
    [...walk(step.body)].filter(
      ({ key, value }) => typeof value === 'number' && /(^|_)id$/.test(key),
    ),
  );

  it('are big enough to overflow 32 bits, and small enough to stay exact in JSON', () => {
    expect(idEntries.length).toBeGreaterThan(30);
    for (const { key, value } of idEntries) {
      expect(Number.isSafeInteger(value), key).toBe(true);
      expect(value as number, key).toBeGreaterThan(2 ** 32);
    }
  });

  it('match the ID inside each GraphQL ID', () => {
    let checked = 0;
    for (const step of allSteps) {
      for (const { key, value, parent } of walk(step.body)) {
        if (key === 'admin_graphql_api_id' && 'id' in parent) {
          expect(value).toBe(String(value).replace(/\d+$/, String(parent.id)));
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('survive a JSON round trip digit for digit', () => {
    for (const step of allSteps) {
      const text = JSON.stringify(step.body);
      expect(JSON.parse(text)).toEqual(step.body);
      for (const { value, key } of walk(step.body)) {
        if (typeof value === 'number' && /(^|_)id$/.test(key)) {
          expect(text).toContain(`:${String(value)}`);
        }
      }
    }
  });
});

describe('the delivery headers', () => {
  it('are the documented ones, with matching values', () => {
    for (const step of allSteps) {
      expect(step.headers['X-Shopify-Topic']).toBe(step.topic);
      expect(step.headers['X-Shopify-Shop-Domain']).toBe(SHOP_DOMAIN);
      expect(step.headers['X-Shopify-API-Version']).toBe(SHOPIFY_API_VERSION);
      expect(step.headers['X-Shopify-Triggered-At']).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      );
    }
  });

  it('have fake HMACs that look real and say that they are fake', () => {
    for (const step of allSteps) {
      const decoded = atob(step.headers['X-Shopify-Hmac-Sha256']);
      expect(decoded).toHaveLength(32);
      expect(decoded.startsWith('fake-hmac:')).toBe(true);
    }
  });

  it('have stable, distinct delivery and event IDs that fit an idempotency key', () => {
    const webhookIds = allSteps.map((step) => step.headers['X-Shopify-Webhook-Id']);
    const eventIds = allSteps.map((step) => step.headers['X-Shopify-Event-Id']);
    expect(new Set([...webhookIds, ...eventIds]).size).toBe(allSteps.length * 2);
    for (const id of [...webhookIds, ...eventIds]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe('fresh deliveries', () => {
  const now = new Date('2026-11-07T12:00:00.000Z');

  it('change the delivery metadata, and nothing else', () => {
    const fresh = freshDelivery(orderCreated, now);
    expect(fresh.headers['X-Shopify-Webhook-Id']).not.toBe(
      orderCreated.headers['X-Shopify-Webhook-Id'],
    );
    expect(fresh.headers['X-Shopify-Event-Id']).not.toBe(
      orderCreated.headers['X-Shopify-Event-Id'],
    );
    expect(fresh.headers['X-Shopify-Triggered-At']).toBe('2026-11-07T12:00:00.000000Z');
    expect(fresh.body).toEqual(orderCreated.body);
    expect(fresh.headers['X-Shopify-Hmac-Sha256']).toBe(
      orderCreated.headers['X-Shopify-Hmac-Sha256'],
    );
    expect(fresh.topic).toBe(orderCreated.topic);
  });

  it('are new every time, and leave the stable fixtures alone', () => {
    const stable = structuredClone(orderCreated.headers);
    const ids = [freshDelivery(orderCreated), freshDelivery(orderCreated)].map(
      (step) => step.headers['X-Shopify-Webhook-Id'],
    );
    expect(ids[0]).not.toBe(ids[1]);
    expect(orderCreated.headers).toEqual(stable);
  });

  it('cover a whole flow, keeping its order and its links', () => {
    const fresh = freshFlow(orderFlow, now);
    expect(fresh.steps.map((step) => step.topic)).toEqual(orderFlow.steps.map((s) => s.topic));
    const ids = fresh.steps.map((step) => step.headers['X-Shopify-Webhook-Id']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(orderFlow.steps.map((s) => s.headers['X-Shopify-Webhook-Id'])).not.toContain(id);
    }
    expect(fresh.steps[2].body.order_id).toBe(fresh.steps[0].body.id);
  });
});

describe('the data', () => {
  const everything = allSteps.flatMap((step) => [
    ...stringsIn(step.body),
    ...Object.values(step.headers),
  ]);

  it('only uses reserved domains', () => {
    const reserved = /(^|\.)example(\.com)?$/;
    const hosts = everything.flatMap((text) =>
      [...text.matchAll(/https?:\/\/([^/?#\s"]+)/g)].map((match) => match[1] ?? ''),
    );
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).toMatch(reserved);

    const emails = everything.flatMap((text) => text.match(/[^\s"<>]+@[^\s"<>]+/g) ?? []);
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email.split('@')[1]).toMatch(reserved);

    expect(SHOP_DOMAIN).toMatch(reserved);
    expect(everything.join('\n')).not.toMatch(/\.myshopify\.com|cdn\.shopify\.com/);
  });

  it('only uses reserved phone numbers and IP addresses', () => {
    const phones = allSteps.flatMap((step) =>
      [...walk(step.body)].flatMap(({ key, value }) =>
        key === 'phone' && typeof value === 'string' ? [value] : [],
      ),
    );
    expect(phones.length).toBeGreaterThan(0);
    for (const phone of phones) expect(phone).toMatch(/555-?01\d\d$/);

    const ips = everything.flatMap((text) => text.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []);
    expect(ips.length).toBeGreaterThan(0);
    for (const ip of ips) expect(ip).toMatch(/^203\.0\.113\.\d+$/);
  });

  it("doesn't reuse the people, shops, or IDs in Shopify's samples", () => {
    const text = JSON.stringify(allSteps.map((step) => [step.body, step.headers]));
    for (const sampleValue of [
      'jon@example.com',
      'john@example.com',
      'Steve Shipper',
      'John Smith',
      'Bob Norman',
      'jsmith',
      'snowdevil',
      'Burton',
      '788032119674292922',
      '820982911946154508',
      '115310627314723954',
    ]) {
      expect(text).not.toContain(sampleValue);
    }
  });

  it('marks the order and its refund as tests, and names the demo', () => {
    expect(orderCreated.body.test).toBe(true);
    expect(orderPaid.body.test).toBe(true);
    expect(refundCreated.body.transactions.every((transaction) => transaction.test)).toBe(true);
    expect(productCreated.body.title).toContain('Demo');
    expect(orderCreated.body.customer?.last_name).toBe('Example');
  });
});

/**
 * Where each fixture's shape comes from. Shopify's samples were read on 2026-11-07. A fixture has
 * the sample's keys and nesting. Its values are fictional, and everything in `inferred` is a place
 * where the docs didn't confirm what a real delivery would hold.
 */

import { SHOPIFY_API_VERSION } from './delivery.js';
import type { ShopifyTopic } from './types.js';

const WEBHOOK_REFERENCE = `https://shopify.dev/docs/api/webhooks/${SHOPIFY_API_VERSION}`;
const TOPICS = `https://shopify.dev/docs/api/admin-graphql/${SHOPIFY_API_VERSION}/enums/WebhookSubscriptionTopic`;
const REST_PRODUCT = `https://shopify.dev/docs/api/admin-rest/${SHOPIFY_API_VERSION}/resources/product`;
const REST_ORDER = `https://shopify.dev/docs/api/admin-rest/${SHOPIFY_API_VERSION}/resources/order`;
const REST_REFUND = `https://shopify.dev/docs/api/admin-rest/${SHOPIFY_API_VERSION}/resources/refund`;

export interface InferredField {
  field: string;
  why: string;
}

export interface FixtureSource {
  /** The page with this topic's sample payload. */
  docUrl: string;
  /** The heading of the sample on that page. */
  sample: string;
  apiVersion: string;
  /** Pages used for fields the sample leaves empty, and for what the topic means. */
  supportingDocs: string[];
  inferred: InferredField[];
}

/** Sources for the delivery headers, and for how those headers behave. */
export const deliverySources = {
  apiVersion: SHOPIFY_API_VERSION,
  headers: 'https://shopify.dev/docs/apps/build/webhooks/delivery-structure',
  deduplicationAndRetries: 'https://shopify.dev/docs/apps/build/webhooks/verify-deliveries',
  inferred: [
    {
      field: 'X-Shopify-Shop-Domain',
      why: 'Shopify sends a myshopify.com domain. This uses the reserved .example TLD so it can never name a real shop.',
    },
    {
      field: 'X-Shopify-Hmac-Sha256',
      why: 'Has the length and encoding of a real signature, but is not one. Nothing can verify it.',
    },
    {
      field: 'X-Shopify-Webhook-Id',
      why: 'The docs call it a unique composite key per delivery and show a UUID, which this copies.',
    },
    {
      field: 'X-Shopify-Name',
      why: 'Left out. Optional, and only sent for a named subscription.',
    },
  ],
} as const;

const productSharedInferred: InferredField[] = [
  {
    field: 'id and every other numeric ID',
    why: 'The sample uses 18-digit IDs above 2^53, which a JavaScript number would round. These use 14 digits, the scale of the 13-digit example on the delivery structure page.',
  },
  {
    field: 'created_at',
    why: "The sample shows null. These use a timestamp, as the REST Product resource's examples do.",
  },
  {
    field: 'options and images',
    why: "The sample leaves them empty. The element shapes come from the REST Product resource's examples.",
  },
  {
    field: 'images[].src',
    why: 'Shopify serves images from its own CDN. These use cdn.example.com so that no real file is referenced.',
  },
  {
    field: 'inventory_item_id',
    why: "The sample shows null. These use IDs, as the REST Product resource's examples do.",
  },
  {
    field: 'media and category',
    why: 'Kept empty and null as in the sample, because the reference does not show them filled in. A real product with images likely lists them in media too.',
  },
];

const orderSharedInferred: InferredField[] = [
  {
    field: 'id and every other numeric ID',
    why: 'The sample uses IDs of up to 18 digits, above 2^53, which a JavaScript number would round. These use 14 digits, the scale of the 13-digit example on the delivery structure page.',
  },
  {
    field: 'tax_lines, line_items[].tax_lines, line_items[].properties, and client_details',
    why: "The sample leaves them empty or null. The shapes come from the REST Order resource's examples.",
  },
  {
    field: 'line_items[].attributed_staffs',
    why: 'The sample has one filled in. These are all empty, because a customer checked out without staff involved.',
  },
  {
    field: 'order_status_url',
    why: 'Shopify uses the shop domain. This uses the .example domain, and keeps the key query parameter the sample has.',
  },
  {
    field: 'browser_ip',
    why: 'From TEST-NET-3 (RFC 5737), so that it can never be a real address.',
  },
  {
    field: 'line_items[].variant_id and line_items[].product_id',
    why: 'The sample has no variant IDs. These point at the product flow so the two flows join up, which the sample does not show.',
  },
];

export const fixtureSources: Record<ShopifyTopic, FixtureSource> = {
  'products/create': {
    docUrl: WEBHOOK_REFERENCE,
    sample: 'products/create: Sample Payload',
    apiVersion: SHOPIFY_API_VERSION,
    supportingDocs: [TOPICS, REST_PRODUCT],
    inferred: productSharedInferred,
  },
  'products/update': {
    docUrl: WEBHOOK_REFERENCE,
    sample: 'products/update: Sample Payload',
    apiVersion: SHOPIFY_API_VERSION,
    supportingDocs: [TOPICS, REST_PRODUCT],
    inferred: [
      ...productSharedInferred,
      {
        field: 'differences from products/create',
        why: "The two samples are byte-identical, so they don't show what an update changes. Which fields change here is a made-up story, and only the shared shape is documented.",
      },
    ],
  },
  'orders/create': {
    docUrl: WEBHOOK_REFERENCE,
    sample: 'orders/create: Sample Payload',
    apiVersion: SHOPIFY_API_VERSION,
    supportingDocs: [TOPICS, REST_ORDER],
    inferred: [
      ...orderSharedInferred,
      {
        field: 'financial_status',
        why: "'authorized' is a documented value, but nothing documents which values orders/create is sent with. The sample shows 'voided', on a cancelled order.",
      },
    ],
  },
  'orders/paid': {
    docUrl: WEBHOOK_REFERENCE,
    sample: 'orders/paid: Sample Payload',
    apiVersion: SHOPIFY_API_VERSION,
    supportingDocs: [TOPICS, REST_ORDER],
    inferred: [
      ...orderSharedInferred,
      {
        field: 'differences from orders/create',
        why: "The two samples are byte-identical. The REST docs don't say which fields change on payment, so changing only financial_status, total_outstanding, and updated_at is a judgment call.",
      },
    ],
  },
  'refunds/create': {
    docUrl: WEBHOOK_REFERENCE,
    sample: 'refunds/create: Sample Payload',
    apiVersion: SHOPIFY_API_VERSION,
    supportingDocs: [TOPICS, REST_REFUND],
    inferred: [
      {
        field: 'id and every other numeric ID',
        why: 'The sample uses IDs of up to 18 digits, above 2^53, which a JavaScript number would round. These use 14 digits, the scale of the 13-digit example on the delivery structure page.',
      },
      {
        field: 'refund_line_items[].line_item.tax_lines and discount_allocations',
        why: "tax_lines' shape comes from the REST Order resource, since the sample leaves it empty. discount_allocations is empty, unlike the sample's, because this order has no discounts.",
      },
      {
        field: 'refund_line_items[].restock_type and location_id',
        why: "The sample shows no_restock and a null location. These use 'cancel' with a location, which the REST Refund resource documents for unfulfilled items.",
      },
      {
        field: 'refund_line_items[].line_item.fulfillable_quantity',
        why: 'The sample keeps it at 1 without a restock. This is 0, because the REST Refund resource says cancelling decreases it. Whether the nested copy reflects that is unconfirmed.',
      },
      {
        field: 'transactions[].parent_id',
        why: "The sample shows null. The REST Refund resource shows the original payment's ID. No fixture carries that payment, because order payloads don't include transactions.",
      },
      {
        field: 'transactions[].currency and processed_at',
        why: "The sample shows null. These hold values, as the REST Refund resource's examples do.",
      },
    ],
  },
};

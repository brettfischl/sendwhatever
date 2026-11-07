/**
 * Delivery headers, and fresh delivery IDs for a resend. Sending a step unchanged looks like a
 * Shopify retry, which the platform should deduplicate on `X-Shopify-Webhook-Id` (PRD §6.2). Sending
 * it through `freshDelivery` looks like a new delivery of the same data, which it should process.
 */

import type { AnyShopifyStep, ShopifyFlow, ShopifyHeaders, ShopifyTopic } from './types.js';

/** The version the fixture shapes come from, per the front matter of the reference (sources.ts). */
export const SHOPIFY_API_VERSION = '2026-10';

/**
 * Real shops are on myshopify.com, where a made-up name could belong to someone. The reserved
 * `.example` TLD can't, so a real shop can never be named by accident.
 */
export const SHOP_DOMAIN = 'fern-and-foundry-demo.myshopify.example';

/** Readable once decoded, and exactly as long as a real signature. */
function fakeHmac(topic: ShopifyTopic): string {
  return btoa(`fake-hmac:${topic}`.padEnd(32, '.'));
}

/** Shopify's documented format: UTC with six decimals, as in 2025-07-10T16:15:47.000000Z. */
function triggeredAt(date: Date): string {
  return date.toISOString().replace(/Z$/, '000Z');
}

export function deliveryHeaders(
  topic: ShopifyTopic,
  delivery: { webhookId: string; eventId: string; triggeredAt: Date },
): ShopifyHeaders {
  return {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': topic,
    'X-Shopify-Hmac-Sha256': fakeHmac(topic),
    'X-Shopify-Shop-Domain': SHOP_DOMAIN,
    'X-Shopify-API-Version': SHOPIFY_API_VERSION,
    'X-Shopify-Webhook-Id': delivery.webhookId,
    'X-Shopify-Triggered-At': triggeredAt(delivery.triggeredAt),
    'X-Shopify-Event-Id': delivery.eventId,
  };
}

/** A copy of the step as a new delivery: new webhook and event IDs, the same body. */
export function freshDelivery<S extends AnyShopifyStep>(step: S, now: Date = new Date()): S {
  return {
    ...step,
    headers: {
      ...step.headers,
      'X-Shopify-Webhook-Id': crypto.randomUUID(),
      'X-Shopify-Triggered-At': triggeredAt(now),
      'X-Shopify-Event-Id': crypto.randomUUID(),
    },
  };
}

/** A copy of the flow with every step a new delivery. */
export function freshFlow<F extends ShopifyFlow>(flow: F, now: Date = new Date()): F {
  return { ...flow, steps: flow.steps.map((step) => freshDelivery(step, now)) };
}

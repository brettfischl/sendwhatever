/**
 * Shopify webhook fixtures for the demo console (PRD §20): fictional data in the shapes Shopify
 * documents, as ordered flows whose IDs link up. This is data only, for a UI to play.
 *
 * Every step goes to `/ingest/shopify`, whatever its topic. Only the first path segment decides the
 * source and so the adapter (PRD §6), so a per-topic path would change nothing but the logged path,
 * and the topic is already in `X-Shopify-Topic`, which the LLM sees.
 */

import { orderFlow } from './orders.js';
import { productFlow } from './products.js';

export { deliveryHeaders, freshDelivery, freshFlow, SHOP_DOMAIN, SHOPIFY_API_VERSION } from './delivery.js';
export { orderFlow } from './orders.js';
export { productFlow } from './products.js';
export { deliverySources, fixtureSources } from './sources.js';
export type { FixtureSource, InferredField } from './sources.js';
export type * from './types.js';

export const shopifyFlows = [productFlow, orderFlow] as const;

/**
 * The payloads and delivery metadata of the Shopify webhook fixtures, typed field for field against
 * the sample payloads in Shopify's webhook reference (see sources.ts). Doing this by hand keeps a
 * fixture from quietly losing or inventing a field: the compiler rejects both.
 */

export type ShopifyTopic =
  | 'products/create'
  | 'products/update'
  | 'orders/create'
  | 'orders/paid'
  | 'refunds/create';

// --- Shared ---------------------------------------------------------------------------------

export interface Money {
  amount: string;
  currency_code: string;
}

export interface MoneySet {
  shop_money: Money;
  presentment_money: Money;
}

export interface TaxLine {
  price: string;
  rate: number;
  title: string;
  price_set: MoneySet;
  channel_liable: boolean | null;
}

// --- products/create and products/update ----------------------------------------------------

export interface ProductVariant {
  admin_graphql_api_id: string;
  barcode: string | null;
  compare_at_price: string | null;
  created_at: string;
  id: number;
  inventory_policy: string;
  position: number;
  price: string;
  product_id: number;
  sku: string | null;
  taxable: boolean;
  title: string;
  updated_at: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  image_id: number | null;
  inventory_item_id: number | null;
  inventory_quantity: number;
  old_inventory_quantity: number;
  barcodes: string[];
}

export interface ProductOption {
  id: number;
  product_id: number;
  name: string;
  position: number;
  values: string[];
}

export interface ProductImage {
  id: number;
  product_id: number;
  position: number;
  created_at: string;
  updated_at: string;
  alt: string | null;
  width: number;
  height: number;
  src: string;
  variant_ids: number[];
  admin_graphql_api_id: string;
}

/** Shopify sends the same resource for both topics, so one type covers both. */
export interface ProductPayload {
  admin_graphql_api_id: string;
  body_html: string | null;
  created_at: string;
  handle: string;
  id: number;
  product_type: string;
  published_at: string | null;
  template_suffix: string | null;
  title: string;
  updated_at: string;
  vendor: string;
  status: 'active' | 'archived' | 'draft';
  published_scope: string;
  tags: string;
  variants: ProductVariant[];
  options: ProductOption[];
  images: ProductImage[];
  image: ProductImage | null;
  media: never[];
  variant_gids: { admin_graphql_api_id: string; updated_at: string }[];
  has_variants_that_requires_components: boolean;
  category: null;
}

// --- orders/create and orders/paid ----------------------------------------------------------

export interface MailingAddress {
  first_name: string;
  address1: string;
  phone: string | null;
  city: string;
  zip: string;
  province: string;
  country: string;
  last_name: string;
  address2: string | null;
  company: string | null;
  latitude: number | null;
  longitude: number | null;
  name: string;
  country_code: string;
  province_code: string;
}

export interface CustomerAddress {
  id: number;
  customer_id: number;
  first_name: string;
  last_name: string;
  company: string | null;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone: string | null;
  name: string;
  province_code: string;
  country_code: string;
  country_name: string;
  default: boolean;
}

export interface Customer {
  id: number;
  created_at: string;
  updated_at: string;
  first_name: string;
  last_name: string;
  state: string;
  note: string | null;
  verified_email: boolean;
  multipass_identifier: string | null;
  tax_exempt: boolean;
  email: string;
  phone: string | null;
  currency: string;
  tax_exemptions: string[];
  admin_graphql_api_id: string;
  default_address: CustomerAddress;
}

export interface ClientDetails {
  accept_language: string | null;
  browser_height: number | null;
  browser_ip: string | null;
  browser_width: number | null;
  session_hash: string | null;
  user_agent: string | null;
}

/** The fields an order's line item shares with the copy nested in a refund. */
export interface RefundedLineItem {
  id: number;
  admin_graphql_api_id: string;
  fulfillable_quantity: number;
  fulfillment_service: string;
  fulfillment_status: string | null;
  gift_card: boolean;
  grams: number;
  name: string;
  price: string;
  price_set: MoneySet;
  product_exists: boolean;
  product_id: number | null;
  properties: { name: string; value: string }[];
  quantity: number;
  requires_shipping: boolean;
  sku: string | null;
  taxable: boolean;
  title: string;
  total_discount: string;
  total_discount_set: MoneySet;
  variant_id: number | null;
  variant_inventory_management: string | null;
  variant_title: string | null;
  vendor: string | null;
  tax_lines: TaxLine[];
  duties: never[];
  discount_allocations: never[];
}

export interface OrderLineItem extends RefundedLineItem {
  attributed_staffs: { id: string; quantity: number }[];
  current_quantity: number;
  sales_line_item_group_id: number | null;
  selling_plan_id: number | null;
}

export interface ShippingLine {
  id: number;
  carrier_identifier: string | null;
  code: string | null;
  current_discounted_price_set: MoneySet;
  discounted_price: string;
  discounted_price_set: MoneySet;
  is_removed: boolean;
  phone: string | null;
  price: string;
  price_set: MoneySet;
  requested_fulfillment_service_id: number | null;
  source: string;
  title: string;
  tax_lines: TaxLine[];
  discount_allocations: never[];
}

/** Shopify sends the same resource for both topics, so one type covers both. */
export interface OrderPayload {
  id: number;
  admin_graphql_api_id: string;
  app_id: number | null;
  browser_ip: string | null;
  buyer_accepts_marketing: boolean;
  cancel_reason: string | null;
  cancelled_at: string | null;
  cart_token: string | null;
  checkout_token: string | null;
  client_details: ClientDetails | null;
  closed_at: string | null;
  confirmation_number: string | null;
  confirmed: boolean;
  contact_email: string | null;
  created_at: string;
  currency: string;
  current_shipping_price_set: MoneySet;
  current_subtotal_price: string;
  current_subtotal_price_set: MoneySet;
  current_total_additional_fees_set: MoneySet | null;
  current_total_discounts: string;
  current_total_discounts_set: MoneySet;
  current_total_duties_set: MoneySet | null;
  current_total_price: string;
  current_total_price_set: MoneySet;
  current_total_tax: string;
  current_total_tax_set: MoneySet;
  customer_locale: string | null;
  device_id: number | null;
  discount_codes: never[];
  duties_included: boolean;
  email: string | null;
  estimated_taxes: boolean;
  financial_status: 'authorized' | 'paid';
  fulfillment_status: string | null;
  landing_site: string | null;
  landing_site_ref: string | null;
  location_id: number | null;
  merchant_business_entity_id: string;
  merchant_of_record_app_id: number | null;
  name: string;
  note: string | null;
  note_attributes: { name: string; value: string }[];
  number: number;
  order_number: number;
  order_status_url: string;
  original_total_additional_fees_set: MoneySet | null;
  original_total_duties_set: MoneySet | null;
  payment_gateway_names: string[];
  phone: string | null;
  po_number: string | null;
  presentment_currency: string;
  processed_at: string;
  reference: string | null;
  referring_site: string | null;
  source_identifier: string | null;
  source_name: string;
  source_url: string | null;
  subtotal_price: string;
  subtotal_price_set: MoneySet;
  tags: string;
  tax_exempt: boolean;
  tax_lines: TaxLine[];
  taxes_included: boolean;
  test: boolean;
  token: string;
  total_cash_rounding_payment_adjustment_set: MoneySet;
  total_cash_rounding_refund_adjustment_set: MoneySet;
  total_discounts: string;
  total_discounts_set: MoneySet;
  total_line_items_price: string;
  total_line_items_price_set: MoneySet;
  total_outstanding: string;
  total_price: string;
  total_price_set: MoneySet;
  total_shipping_price_set: MoneySet;
  total_tax: string;
  total_tax_set: MoneySet;
  total_tip_received: string;
  total_weight: number;
  updated_at: string;
  user_id: number | null;
  billing_address: MailingAddress | null;
  customer: Customer | null;
  discount_applications: never[];
  fulfillments: never[];
  line_items: OrderLineItem[];
  payment_terms: null;
  refunds: never[];
  shipping_address: MailingAddress | null;
  shipping_lines: ShippingLine[];
  returns: never[];
  line_item_groups: never[];
}

// --- refunds/create -------------------------------------------------------------------------

export interface RefundLineItem {
  id: number;
  quantity: number;
  line_item_id: number;
  location_id: number | null;
  restock_type: 'no_restock' | 'cancel' | 'return';
  /** A JSON number here, though every other amount in these payloads is a string. As Shopify sends it. */
  subtotal: number;
  total_tax: number;
  subtotal_set: MoneySet;
  total_tax_set: MoneySet;
  line_item: RefundedLineItem;
}

/** Inside a transaction Shopify writes `currency`, not the `currency_code` of `Money`. */
export interface UnsettledMoney {
  amount: string;
  currency: string;
}

export interface RefundTransaction {
  id: number;
  order_id: number;
  kind: 'refund';
  gateway: string;
  status: string;
  message: string | null;
  created_at: string;
  test: boolean;
  authorization: string | null;
  location_id: number | null;
  user_id: number | null;
  parent_id: number | null;
  processed_at: string | null;
  device_id: number | null;
  error_code: string | null;
  source_name: string;
  receipt: Record<string, never>;
  amount: string;
  currency: string | null;
  payment_id: string;
  total_unsettled_set: { presentment_money: UnsettledMoney; shop_money: UnsettledMoney };
  manual_payment_gateway: boolean;
  amount_rounding: string | null;
  admin_graphql_api_id: string;
}

export interface RefundPayload {
  id: number;
  order_id: number;
  created_at: string;
  note: string | null;
  user_id: number | null;
  processed_at: string;
  duties: never[];
  total_duties_set: MoneySet;
  return: null;
  refund_shipping_lines: never[];
  restock: boolean;
  admin_graphql_api_id: string;
  order_adjustments: never[];
  refund_line_items: RefundLineItem[];
  transactions: RefundTransaction[];
}

// --- Delivery -------------------------------------------------------------------------------

export interface ShopifyBodies {
  'products/create': ProductPayload;
  'products/update': ProductPayload;
  'orders/create': OrderPayload;
  'orders/paid': OrderPayload;
  'refunds/create': RefundPayload;
}

/** The headers of an HTTPS delivery. `X-Shopify-Name` is left out: it needs a named subscription. */
export interface ShopifyHeaders {
  'Content-Type': 'application/json';
  'X-Shopify-Topic': ShopifyTopic;
  /** Base64 of 32 bytes like a real HMAC-SHA256, but spelling out that it's fake. Never verifiable. */
  'X-Shopify-Hmac-Sha256': string;
  'X-Shopify-Shop-Domain': string;
  'X-Shopify-API-Version': string;
  /** Identifies this delivery. Repeating a send with it unchanged is how Shopify retries look. */
  'X-Shopify-Webhook-Id': string;
  'X-Shopify-Triggered-At': string;
  /** Identifies the merchant action behind the delivery. */
  'X-Shopify-Event-Id': string;
}

export interface ShopifyStep<T extends ShopifyTopic = ShopifyTopic> {
  /** Stable, for UI keys. */
  id: string;
  label: string;
  /** One or two plain-English sentences for the UI. */
  description: string;
  topic: T;
  method: 'POST';
  /** Excludes the `?key=` query, which the sender adds. */
  path: '/ingest/shopify';
  headers: ShopifyHeaders;
  body: ShopifyBodies[T];
}

/** A step whose `topic` narrows its `body`. */
export type AnyShopifyStep = { [T in ShopifyTopic]: ShopifyStep<T> }[ShopifyTopic];

export interface ShopifyFlow<Steps extends readonly AnyShopifyStep[] = readonly AnyShopifyStep[]> {
  id: string;
  label: string;
  description: string;
  /** In the order they should be sent. */
  steps: Steps;
}

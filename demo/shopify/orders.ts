/**
 * The order flow. A customer buys two jackets from the product flow, plus gift wrap that isn't a
 * product, so its product fields are null. The payment is authorized, then captured, and then one
 * unfulfilled jacket is refunded.
 *
 * Money adds up. Line items: 89.00 + 89.00 + 5.00 = 183.00. Tax: 8% of each jacket, 7.12 + 7.12.
 * Shipping: 10.00. Total: 207.24. The refund is one jacket with its tax: 89.00 + 7.12 = 96.12.
 */

import { deliveryHeaders } from './delivery.js';
import { PRODUCT_ID, VARIANT_MEDIUM_ID, VARIANT_SMALL_ID } from './products.js';
import type {
  Customer,
  MailingAddress,
  MoneySet,
  OrderLineItem,
  OrderPayload,
  RefundPayload,
  RefundedLineItem,
  ShippingLine,
  ShopifyFlow,
  ShopifyStep,
  TaxLine,
} from './types.js';

export const ORDER_ID = 58101000000601;
export const CUSTOMER_ID = 72102000000701;
export const LINE_ITEM_SMALL_ID = 15103000000801;
export const LINE_ITEM_MEDIUM_ID = 15103000000802;
export const LINE_ITEM_GIFT_WRAP_ID = 15103000000803;
export const REFUND_ID = 96104000000901;

const CUSTOMER_ADDRESS_ID = 81105000001001;
const SHIPPING_LINE_ID = 52106000001101;
const REFUND_LINE_ITEM_ID = 63107000001201;
/** The capture this refund reverses. Order payloads don't carry their transactions. */
const PAYMENT_TRANSACTION_ID = 27108000001301;
const REFUND_TRANSACTION_ID = 27108000001302;
const STAFF_USER_ID = 11109000001401;
const RESTOCK_LOCATION_ID = 66110000001501;

const CREATED_AT = '2026-10-21T14:05:12-04:00';
const PAID_AT = '2026-10-22T10:30:45-04:00';
const REFUNDED_AT = '2026-10-23T16:20:05-04:00';

const TOKEN = 'demo0token0not0a0real0order00001';

function money(amount: string): MoneySet {
  return {
    shop_money: { amount, currency_code: 'USD' },
    presentment_money: { amount, currency_code: 'USD' },
  };
}

const name = { first_name: 'Robin', last_name: 'Example', name: 'Robin Example' };
const place = {
  address1: '123 Example Street',
  address2: null,
  city: 'Exampleville',
  zip: '00000',
  province: 'Oregon',
  province_code: 'OR',
  country: 'United States',
  country_code: 'US',
};

const address: MailingAddress = {
  ...name,
  ...place,
  phone: '+12025550123',
  company: null,
  latitude: null,
  longitude: null,
};

const customer: Customer = {
  id: CUSTOMER_ID,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  first_name: name.first_name,
  last_name: name.last_name,
  state: 'disabled',
  note: null,
  verified_email: true,
  multipass_identifier: null,
  tax_exempt: false,
  email: 'robin.example@example.com',
  phone: null,
  currency: 'USD',
  tax_exemptions: [],
  admin_graphql_api_id: `gid://shopify/Customer/${CUSTOMER_ID}`,
  default_address: {
    ...name,
    ...place,
    id: CUSTOMER_ADDRESS_ID,
    customer_id: CUSTOMER_ID,
    company: null,
    phone: '+12025550123',
    country_name: 'United States',
    default: true,
  },
};

function stateTax(price: string): TaxLine {
  return { price, rate: 0.08, title: 'Demo State Tax', price_set: money(price), channel_liable: null };
}

function jacket(id: number, variantId: number, size: string): OrderLineItem {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/LineItem/${id}`,
    attributed_staffs: [],
    current_quantity: 1,
    fulfillable_quantity: 1,
    fulfillment_service: 'manual',
    fulfillment_status: null,
    gift_card: false,
    grams: 1200,
    name: `Demo Waxed Field Jacket - ${size} / Moss`,
    price: '89.00',
    price_set: money('89.00'),
    product_exists: true,
    product_id: PRODUCT_ID,
    properties: [],
    quantity: 1,
    requires_shipping: true,
    sales_line_item_group_id: null,
    selling_plan_id: null,
    sku: `DEMO-JKT-MOSS-${size.charAt(0)}`,
    taxable: true,
    title: 'Demo Waxed Field Jacket',
    total_discount: '0.00',
    total_discount_set: money('0.00'),
    variant_id: variantId,
    variant_inventory_management: 'shopify',
    variant_title: `${size} / Moss`,
    vendor: 'Fern & Foundry Demo',
    tax_lines: [stateTax('7.12')],
    duties: [],
    discount_allocations: [],
  };
}

const smallJacket = jacket(LINE_ITEM_SMALL_ID, VARIANT_SMALL_ID, 'Small');

const giftWrap: OrderLineItem = {
  ...jacket(LINE_ITEM_GIFT_WRAP_ID, VARIANT_SMALL_ID, 'Small'),
  grams: 0,
  name: 'Demo Gift Wrap',
  price: '5.00',
  price_set: money('5.00'),
  product_exists: false,
  product_id: null,
  properties: [{ name: 'Gift message', value: 'A fictional gift message.' }],
  requires_shipping: false,
  sku: null,
  taxable: false,
  title: 'Demo Gift Wrap',
  variant_id: null,
  variant_inventory_management: null,
  variant_title: null,
  vendor: null,
  tax_lines: [],
};

const shippingLine: ShippingLine = {
  id: SHIPPING_LINE_ID,
  carrier_identifier: null,
  code: 'Demo Ground',
  current_discounted_price_set: money('10.00'),
  discounted_price: '10.00',
  discounted_price_set: money('10.00'),
  is_removed: false,
  phone: null,
  price: '10.00',
  price_set: money('10.00'),
  requested_fulfillment_service_id: null,
  source: 'shopify',
  title: 'Demo Ground',
  tax_lines: [],
  discount_allocations: [],
};

const authorized: OrderPayload = {
  id: ORDER_ID,
  admin_graphql_api_id: `gid://shopify/Order/${ORDER_ID}`,
  app_id: null,
  browser_ip: '203.0.113.42',
  buyer_accepts_marketing: false,
  cancel_reason: null,
  cancelled_at: null,
  cart_token: 'demo0cart0token0000000000000001',
  checkout_token: 'demo0checkout0token00000000001',
  client_details: {
    accept_language: 'en-US',
    browser_height: 900,
    browser_ip: '203.0.113.42',
    browser_width: 1440,
    session_hash: null,
    user_agent: 'DemoBrowser/1.0 (fictional)',
  },
  closed_at: null,
  confirmation_number: 'DEMO00001',
  confirmed: true,
  contact_email: customer.email,
  created_at: CREATED_AT,
  currency: 'USD',
  current_shipping_price_set: money('10.00'),
  current_subtotal_price: '183.00',
  current_subtotal_price_set: money('183.00'),
  current_total_additional_fees_set: null,
  current_total_discounts: '0.00',
  current_total_discounts_set: money('0.00'),
  current_total_duties_set: null,
  current_total_price: '207.24',
  current_total_price_set: money('207.24'),
  current_total_tax: '14.24',
  current_total_tax_set: money('14.24'),
  customer_locale: 'en',
  device_id: null,
  discount_codes: [],
  duties_included: false,
  email: customer.email,
  estimated_taxes: false,
  financial_status: 'authorized',
  fulfillment_status: null,
  landing_site: '/',
  landing_site_ref: null,
  location_id: null,
  merchant_business_entity_id: 'REVNTzAwMDAwMDAx',
  merchant_of_record_app_id: null,
  name: '#1001',
  note: 'Fictional order for the demo console.',
  note_attributes: [],
  number: 1,
  order_number: 1001,
  order_status_url: `https://fern-and-foundry-demo.myshopify.example/orders/${TOKEN}/authenticate?key=not-a-real-key`,
  original_total_additional_fees_set: null,
  original_total_duties_set: null,
  payment_gateway_names: ['bogus'],
  phone: null,
  po_number: null,
  presentment_currency: 'USD',
  processed_at: CREATED_AT,
  reference: null,
  referring_site: 'https://referrer.example.com/',
  source_identifier: null,
  source_name: 'web',
  source_url: null,
  subtotal_price: '183.00',
  subtotal_price_set: money('183.00'),
  tags: 'demo',
  tax_exempt: false,
  tax_lines: [stateTax('14.24')],
  taxes_included: false,
  test: true,
  token: TOKEN,
  total_cash_rounding_payment_adjustment_set: money('0.00'),
  total_cash_rounding_refund_adjustment_set: money('0.00'),
  total_discounts: '0.00',
  total_discounts_set: money('0.00'),
  total_line_items_price: '183.00',
  total_line_items_price_set: money('183.00'),
  total_outstanding: '207.24',
  total_price: '207.24',
  total_price_set: money('207.24'),
  total_shipping_price_set: money('10.00'),
  total_tax: '14.24',
  total_tax_set: money('14.24'),
  total_tip_received: '0.00',
  total_weight: 2400,
  updated_at: CREATED_AT,
  user_id: null,
  billing_address: address,
  customer,
  discount_applications: [],
  fulfillments: [],
  line_items: [smallJacket, jacket(LINE_ITEM_MEDIUM_ID, VARIANT_MEDIUM_ID, 'Medium'), giftWrap],
  payment_terms: null,
  refunds: [],
  shipping_address: address,
  shipping_lines: [shippingLine],
  returns: [],
  line_item_groups: [],
};

const paid: OrderPayload = {
  ...authorized,
  financial_status: 'paid',
  total_outstanding: '0.00',
  updated_at: PAID_AT,
};

/** Copies a line item as a refund nests it: without the order-only fields, as of the refund. */
function asRefunded(item: OrderLineItem): RefundedLineItem {
  const {
    attributed_staffs: _attributedStaffs,
    current_quantity: _currentQuantity,
    sales_line_item_group_id: _salesLineItemGroupId,
    selling_plan_id: _sellingPlanId,
    ...shared
  } = item;
  return { ...shared, fulfillable_quantity: 0 };
}

const refund: RefundPayload = {
  id: REFUND_ID,
  order_id: ORDER_ID,
  created_at: REFUNDED_AT,
  note: 'Customer changed their mind about the Small before it shipped.',
  user_id: STAFF_USER_ID,
  processed_at: REFUNDED_AT,
  duties: [],
  total_duties_set: money('0.00'),
  return: null,
  refund_shipping_lines: [],
  restock: true,
  admin_graphql_api_id: `gid://shopify/Refund/${REFUND_ID}`,
  order_adjustments: [],
  refund_line_items: [
    {
      id: REFUND_LINE_ITEM_ID,
      quantity: 1,
      line_item_id: LINE_ITEM_SMALL_ID,
      location_id: RESTOCK_LOCATION_ID,
      restock_type: 'cancel',
      subtotal: 89,
      total_tax: 7.12,
      subtotal_set: money('89.00'),
      total_tax_set: money('7.12'),
      line_item: asRefunded(smallJacket),
    },
  ],
  transactions: [
    {
      id: REFUND_TRANSACTION_ID,
      order_id: ORDER_ID,
      kind: 'refund',
      gateway: 'bogus',
      status: 'success',
      message: 'Fictional refund.',
      created_at: REFUNDED_AT,
      test: true,
      authorization: null,
      location_id: null,
      user_id: STAFF_USER_ID,
      parent_id: PAYMENT_TRANSACTION_ID,
      processed_at: REFUNDED_AT,
      device_id: null,
      error_code: null,
      source_name: 'web',
      receipt: {},
      amount: '96.12',
      currency: 'USD',
      payment_id: '#1001.2',
      total_unsettled_set: {
        presentment_money: { amount: '0.0', currency: 'XXX' },
        shop_money: { amount: '0.0', currency: 'XXX' },
      },
      manual_payment_gateway: false,
      amount_rounding: null,
      admin_graphql_api_id: `gid://shopify/OrderTransaction/${REFUND_TRANSACTION_ID}`,
    },
  ],
};

const orderCreatedStep: ShopifyStep<'orders/create'> = {
  id: 'order-created',
  label: 'Order created',
  description:
    'A customer checks out with two jackets and gift wrap. The card is authorized but not yet charged, so the full total is still outstanding.',
  topic: 'orders/create',
  method: 'POST',
  path: '/ingest/shopify',
  headers: deliveryHeaders('orders/create', {
    webhookId: 'f6e0a1c4-3b52-4d07-9a11-0c5e7d2b1b01',
    eventId: 'c17b9d2e-84a6-4f13-b6d0-3e92a4c7f601',
    triggeredAt: new Date('2026-10-21T18:05:13.000Z'),
  }),
  body: authorized,
};

const orderPaidStep: ShopifyStep<'orders/paid'> = {
  id: 'order-paid',
  label: 'Order paid',
  description:
    'The merchant captures the payment. Shopify resends the whole order with the same structure, and only the payment status, the amount outstanding, and the update time change.',
  topic: 'orders/paid',
  method: 'POST',
  path: '/ingest/shopify',
  headers: deliveryHeaders('orders/paid', {
    webhookId: 'f6e0a1c4-3b52-4d07-9a11-0c5e7d2b1b02',
    eventId: 'c17b9d2e-84a6-4f13-b6d0-3e92a4c7f602',
    triggeredAt: new Date('2026-10-22T14:30:46.000Z'),
  }),
  body: paid,
};

const refundCreatedStep: ShopifyStep<'refunds/create'> = {
  id: 'refund-created',
  label: 'Refund created',
  description:
    'The merchant refunds the Small jacket before it ships. This is a different shape altogether: a refund that points back at the order and at the line item, with the money moved in its own transaction.',
  topic: 'refunds/create',
  method: 'POST',
  path: '/ingest/shopify',
  headers: deliveryHeaders('refunds/create', {
    webhookId: 'f6e0a1c4-3b52-4d07-9a11-0c5e7d2b1b03',
    eventId: 'c17b9d2e-84a6-4f13-b6d0-3e92a4c7f603',
    triggeredAt: new Date('2026-10-23T20:20:06.000Z'),
  }),
  body: refund,
};

export const orderFlow: ShopifyFlow<
  readonly [
    ShopifyStep<'orders/create'>,
    ShopifyStep<'orders/paid'>,
    ShopifyStep<'refunds/create'>,
  ]
> = {
  id: 'order',
  label: 'Order to refund',
  description: 'An order is placed, then paid, and then part of it is refunded.',
  steps: [orderCreatedStep, orderPaidStep, refundCreatedStep],
};

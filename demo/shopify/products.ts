/**
 * The product flow. A draft jacket is created, then published with a new size, a second image, and
 * a sale price. Both payloads have the same keys, as Shopify's do, but fields that were null on the
 * draft now have values, which is what makes the two shapes differ.
 */

import { deliveryHeaders } from './delivery.js';
import type {
  ProductImage,
  ProductOption,
  ProductPayload,
  ProductVariant,
  ShopifyFlow,
  ShopifyStep,
} from './types.js';

// These IDs are also what the order flow buys.
export const PRODUCT_ID = 77001000000101;
export const VARIANT_SMALL_ID = 44102000000201;
export const VARIANT_MEDIUM_ID = 44102000000202;
export const VARIANT_LARGE_ID = 44102000000203;

const OPTION_SIZE_ID = 91003000000301;
const OPTION_COLOR_ID = 91003000000302;
const IMAGE_FRONT_ID = 33104000000401;
const IMAGE_BACK_ID = 33104000000402;

const CREATED_AT = '2026-10-20T09:15:00-04:00';
const UPDATED_AT = '2026-10-20T09:42:30-04:00';

const productGid = `gid://shopify/Product/${PRODUCT_ID}`;

function draftVariant(
  id: number,
  position: number,
  size: string,
  inventoryItemId: number,
  inventory: number,
): ProductVariant {
  return {
    admin_graphql_api_id: `gid://shopify/ProductVariant/${id}`,
    barcode: null,
    compare_at_price: null,
    created_at: CREATED_AT,
    id,
    inventory_policy: 'deny',
    position,
    price: '89.00',
    product_id: PRODUCT_ID,
    sku: `DEMO-JKT-MOSS-${size.charAt(0)}`,
    taxable: true,
    title: `${size} / Moss`,
    updated_at: CREATED_AT,
    option1: size,
    option2: 'Moss',
    option3: null,
    image_id: null,
    inventory_item_id: inventoryItemId,
    inventory_quantity: inventory,
    old_inventory_quantity: inventory,
    barcodes: [],
  };
}

function options(sizes: string[]): ProductOption[] {
  return [
    { id: OPTION_SIZE_ID, product_id: PRODUCT_ID, name: 'Size', position: 1, values: sizes },
    { id: OPTION_COLOR_ID, product_id: PRODUCT_ID, name: 'Color', position: 2, values: ['Moss'] },
  ];
}

function image(
  id: number,
  position: number,
  alt: string | null,
  file: string,
  createdAt: string,
  updatedAt: string,
  variantIds: number[],
): ProductImage {
  return {
    id,
    product_id: PRODUCT_ID,
    position,
    created_at: createdAt,
    updated_at: updatedAt,
    alt,
    width: 1600,
    height: 2000,
    src: `https://cdn.example.com/fern-and-foundry-demo/${file}`,
    variant_ids: variantIds,
    admin_graphql_api_id: `gid://shopify/ProductImage/${id}`,
  };
}

const draftVariants = [
  draftVariant(VARIANT_SMALL_ID, 1, 'Small', 46105000000501, 25),
  draftVariant(VARIANT_MEDIUM_ID, 2, 'Medium', 46105000000502, 30),
];

const draftImage = image(IMAGE_FRONT_ID, 1, null, 'jacket-front.jpg', CREATED_AT, CREATED_AT, []);

const created: ProductPayload = {
  admin_graphql_api_id: productGid,
  body_html: null,
  created_at: CREATED_AT,
  handle: 'demo-waxed-field-jacket',
  id: PRODUCT_ID,
  product_type: 'Outerwear',
  published_at: null,
  template_suffix: null,
  title: 'Demo Waxed Field Jacket',
  updated_at: CREATED_AT,
  vendor: 'Fern & Foundry Demo',
  status: 'draft',
  published_scope: 'web',
  tags: 'demo, outerwear',
  variants: draftVariants,
  options: options(['Small', 'Medium']),
  images: [draftImage],
  image: draftImage,
  media: [],
  variant_gids: draftVariants.map((variant) => ({
    admin_graphql_api_id: variant.admin_graphql_api_id,
    updated_at: '2026-10-20T13:15:00.000Z',
  })),
  has_variants_that_requires_components: false,
  category: null,
};

const publishedVariants: ProductVariant[] = [
  ...draftVariants,
  { ...draftVariant(VARIANT_LARGE_ID, 3, 'Large', 46105000000503, 15), created_at: UPDATED_AT },
].map((variant) => ({
  ...variant,
  compare_at_price: '110.00',
  image_id: variant.id === VARIANT_LARGE_ID ? IMAGE_BACK_ID : IMAGE_FRONT_ID,
  updated_at: UPDATED_AT,
}));

const publishedImages = [
  image(
    IMAGE_FRONT_ID,
    1,
    'Front of the demo jacket',
    'jacket-front.jpg',
    CREATED_AT,
    UPDATED_AT,
    [VARIANT_SMALL_ID, VARIANT_MEDIUM_ID],
  ),
  image(
    IMAGE_BACK_ID,
    2,
    'Back of the demo jacket',
    'jacket-back.jpg',
    UPDATED_AT,
    UPDATED_AT,
    [VARIANT_LARGE_ID],
  ),
];

const published: ProductPayload = {
  ...created,
  body_html: '<p>A fictional jacket for a fictional shop.</p>',
  published_at: UPDATED_AT,
  updated_at: UPDATED_AT,
  status: 'active',
  template_suffix: 'demo-sale',
  tags: 'demo, outerwear, sale',
  variants: publishedVariants,
  options: options(['Small', 'Medium', 'Large']),
  images: publishedImages,
  image: publishedImages[0] ?? null,
  variant_gids: publishedVariants.map((variant) => ({
    admin_graphql_api_id: variant.admin_graphql_api_id,
    updated_at: '2026-10-20T13:42:30.000Z',
  })),
};

const productCreatedStep: ShopifyStep<'products/create'> = {
  id: 'product-created',
  label: 'Product created',
  description:
    "A merchant saves a new jacket as a draft, with two sizes and one photo. It has no sale price and isn't published yet, so those fields arrive as null.",
  topic: 'products/create',
  method: 'POST',
  path: '/ingest/shopify',
  headers: deliveryHeaders('products/create', {
    webhookId: 'f6e0a1c4-3b52-4d07-9a11-0c5e7d2b1a01',
    eventId: 'c17b9d2e-84a6-4f13-b6d0-3e92a4c7f501',
    triggeredAt: new Date('2026-10-20T13:15:01.000Z'),
  }),
  body: created,
};

const productUpdatedStep: ShopifyStep<'products/update'> = {
  id: 'product-updated',
  label: 'Product updated',
  description:
    'The merchant publishes the jacket, adding a Large size, a second photo, and a sale price. Shopify resends the whole product, not just what changed, and the fields that were null now have values.',
  topic: 'products/update',
  method: 'POST',
  path: '/ingest/shopify',
  headers: deliveryHeaders('products/update', {
    webhookId: 'f6e0a1c4-3b52-4d07-9a11-0c5e7d2b1a02',
    eventId: 'c17b9d2e-84a6-4f13-b6d0-3e92a4c7f502',
    triggeredAt: new Date('2026-10-20T13:42:31.000Z'),
  }),
  body: published,
};

export const productFlow: ShopifyFlow<
  readonly [ShopifyStep<'products/create'>, ShopifyStep<'products/update'>]
> = {
  id: 'product',
  label: 'Create a product',
  description: 'A product is created as a draft, then published with more sizes and photos.',
  steps: [productCreatedStep, productUpdatedStep],
};

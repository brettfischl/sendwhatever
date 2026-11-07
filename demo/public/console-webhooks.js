// Placeholder for the guided Shopify flows (sw-ddd.3), which replace this file. See console.js for mount().

import { h } from './common.js';

export function mount(slot) {
  slot.replaceChildren(
    h(
      'div',
      { className: 'slot-placeholder' },
      h('h2', {}, 'Webhooks'),
      h('p', {}, 'Guided Shopify flows are coming here: product creation, and order creation through to refund.'),
    ),
  );
}

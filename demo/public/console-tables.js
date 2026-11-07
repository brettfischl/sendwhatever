// Placeholder for the live tables view (sw-ddd.4), which replaces this file. See console.js for mount().

import { h } from './common.js';

export function mount(slot, { target }) {
  slot.replaceChildren(
    h(
      'div',
      { className: 'slot-placeholder' },
      h('h2', {}, 'Live tables'),
      h(
        'p',
        {},
        target.mode === 'stub'
          ? 'The built-in stub stores nothing, so there are no tables to watch here.'
          : 'Tables, columns, and rows will appear here as events are processed.',
      ),
    ),
  );
}

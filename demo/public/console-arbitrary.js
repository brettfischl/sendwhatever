// Arbitrary JSON mode: write any JSON, choose how to send it, and send it through the demo server.

import { h, showError } from './common.js';
import { checkBody, formatJson, highlightJson, MAX_HIGHLIGHT_CHARS } from './console-format.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const pretty = (value) => JSON.stringify(value, null, 2);

const EXAMPLES = [
  {
    name: 'Customer',
    method: 'POST',
    path: '',
    headers: JSON_HEADERS,
    body: pretty({
      email: 'ada@example.com',
      profile: { first_name: 'Ada', last_name: 'Lovelace' },
      orders: [
        { sku: 'A1', amount: 100 },
        { sku: 'A2', amount: 200 },
      ],
    }),
  },
  {
    name: 'Batch',
    method: 'POST',
    path: 'signups',
    headers: JSON_HEADERS,
    body: pretty([
      { email: 'grace@example.com', plan: 'team', signed_up_at: '2026-11-07T09:30:00-05:00' },
      { email: 'alan@example.com', plan: 'free', signed_up_at: '2026-11-07T09:42:00-05:00', referred_by: 'grace@example.com' },
    ]),
  },
  {
    name: 'Partial update',
    method: 'PATCH',
    path: 'customers/123',
    headers: JSON_HEADERS,
    body: pretty({ id: 123, plan: 'enterprise', seats: 250 }),
  },
  {
    name: 'Delete',
    method: 'DELETE',
    path: 'customers/123',
    headers: JSON_HEADERS,
    body: '',
  },
  {
    name: 'Custom headers',
    method: 'POST',
    path: 'sensors',
    headers: { ...JSON_HEADERS, 'X-Device-Fleet': 'greenhouse-4', 'Idempotency-Key': 'reading-20261107-0001' },
    body: pretty({
      device: 'gh4-soil-07',
      read_at: '2026-11-07T14:05:00Z',
      readings: { moisture_pct: 41.5, temp_c: 18.2 },
      battery: { level: 0.82, charging: false },
    }),
  },
  {
    name: 'Broken JSON',
    method: 'POST',
    path: '',
    headers: JSON_HEADERS,
    body: '{\n  "email": "ada@example.com",\n  "plan": "team",\n}',
  },
];

export function mount(slot, { target, send }) {
  const find = (selector) => slot.querySelector(selector);
  const composer = find('#composer');
  const method = find('#method');
  const path = find('#path');
  const editor = find('#editor');
  const highlight = find('#editor-highlight');
  const gutter = find('#editor-gutter');
  const gutterLines = gutter.firstElementChild;
  const validity = find('#validity');
  const sendButton = find('#send');
  const sendAnyway = find('#send-anyway');
  const formatButton = find('#format');
  const headers = find('#headers');
  const headersSummary = find('#headers-summary');
  const headerRows = find('#header-rows');

  let check = { state: 'valid', message: '' };
  let sending = false;

  function syncScroll() {
    const offset = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
    highlight.style.transform = offset;
    gutterLines.style.transform = `translateY(${-editor.scrollTop}px)`;
  }

  function renderGutter(text) {
    const count = text.split('\n').length;
    const lines = [];
    for (let line = 1; line <= count; line += 1) {
      lines.push(h('div', { className: line === check.line ? 'gutter-error' : '' }, String(line)));
    }
    gutterLines.replaceChildren(...lines);
  }

  function refresh() {
    const text = editor.value;
    check = checkBody(text, method.value);
    const invalid = check.state === 'invalid';

    const tooBig = text.length > MAX_HIGHLIGHT_CHARS;
    editor.classList.toggle('editor-plain', tooBig);
    // The final newline needs a line of its own, or the colors fall out of step with the text.
    if (tooBig) highlight.replaceChildren();
    else highlight.replaceChildren(highlightJson(text), '\n');
    renderGutter(text);

    validity.className = `validity validity-${check.state}`;
    validity.textContent = check.line
      ? `Line ${check.line}, column ${check.column}: ${check.message}`
      : check.message;
    validity.disabled = !check.line;
    sendAnyway.hidden = !invalid;
    formatButton.disabled = check.state !== 'valid' && check.state !== 'scalar';
    updateSendButtons();
    syncScroll();
  }

  function updateSendButtons() {
    sendButton.disabled = sending || check.state === 'invalid';
    sendAnyway.disabled = sending;
    sendButton.textContent = sending ? 'Sending…' : 'Send';
  }

  /**
   * For short insertions only. It goes through the browser's editing command so Ctrl+Z still works,
   * but that command takes seconds on a few KB of multi-line text.
   */
  function insertShortText(text) {
    if (!document.execCommand('insertText', false, text)) {
      editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    }
    refresh();
  }

  function setHeaders(values) {
    headerRows.replaceChildren(...Object.entries(values).map(([name, value]) => headerRow(name, value)));
    updateHeadersSummary();
  }

  function headerRow(name = '', value = '') {
    const row = h(
      'div',
      { className: 'header-row' },
      h('input', { value: name, placeholder: 'Name', ariaLabel: 'Header name', spellcheck: false, autocomplete: 'off' }),
      h('input', { value, placeholder: 'Value', ariaLabel: 'Header value', spellcheck: false, autocomplete: 'off' }),
      h('button', {
        type: 'button',
        className: 'header-remove',
        ariaLabel: `Remove ${name || 'this'} header`,
        onclick: () => {
          row.remove();
          updateHeadersSummary();
        },
      }, '×'),
    );
    return row;
  }

  function readHeaders() {
    const values = {};
    for (const row of headerRows.children) {
      const [name, value] = row.querySelectorAll('input');
      // Name, not value, decides whether a row counts: a header can have an empty value.
      if (name.value.trim()) values[name.value.trim()] = value.value;
      else if (value.value) throw new Error(`The header with the value "${value.value}" has no name`);
    }
    return values;
  }

  function updateHeadersSummary() {
    const count = [...headerRows.children].filter((row) => row.querySelector('input').value.trim()).length;
    headersSummary.textContent = `Headers (${count})`;
  }

  function loadExample(example) {
    method.value = example.method;
    path.value = example.path;
    setHeaders(example.headers);
    headers.open = Object.keys(example.headers).length > 1;
    editor.value = example.body;
    editor.scrollTop = 0;
    editor.scrollLeft = 0;
    refresh();
  }

  async function submit({ force }) {
    if (sending) return;
    refresh();
    if (check.state === 'invalid' && !force) {
      jumpToError();
      return;
    }
    let headerValues;
    try {
      headerValues = readHeaders();
    } catch (error) {
      headers.open = true;
      showError(error);
      return;
    }
    sending = true;
    updateSendButtons();
    try {
      await send({
        label: 'Console',
        method: method.value,
        path: path.value.trim(),
        headers: headerValues,
        // A body of only whitespace is empty, and it's what checkBody judged.
        body: editor.value.trim() ? editor.value : null,
      });
    } catch {
      // The panel already shows why it wasn't sent.
    } finally {
      sending = false;
      updateSendButtons();
    }
  }

  function jumpToError() {
    editor.focus();
    if (check.offset !== undefined) editor.setSelectionRange(check.offset, check.offset + 1);
  }

  find('#examples').replaceChildren(
    ...EXAMPLES.map((example) =>
      h('button', { type: 'button', className: 'example', onclick: () => loadExample(example) }, example.name),
    ),
  );

  find('#locked-headers').replaceChildren(
    h('div', {}, h('code', {}, 'Authorization: Bearer ••••••••')),
    target.accountSlug ? h('div', {}, h('code', {}, `X-Account-Slug: ${target.accountSlug}`)) : null,
    h('p', {}, 'Added by the demo server, so the key never reaches this browser.'),
  );

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    submit({ force: false });
  });
  sendAnyway.addEventListener('click', () => submit({ force: true }));
  validity.addEventListener('click', jumpToError);
  method.addEventListener('change', refresh);
  find('#add-header').addEventListener('click', () => {
    const row = headerRow();
    headerRows.append(row);
    row.querySelector('input').focus();
    updateHeadersSummary();
  });
  headerRows.addEventListener('input', updateHeadersSummary);
  formatButton.addEventListener('click', () => {
    editor.value = formatJson(editor.value);
    editor.focus();
    refresh();
  });
  editor.addEventListener('input', refresh);
  editor.addEventListener('scroll', syncScroll);
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit({ force: false });
    } else if (event.key === 'Tab' && !event.shiftKey) {
      // Escape first, then Tab, leaves the editor for anyone not using a mouse.
      if (editor.dataset.tabLeaves) return;
      event.preventDefault();
      insertShortText('  ');
    } else if (event.key === 'Escape') {
      editor.dataset.tabLeaves = 'true';
    }
  });
  editor.addEventListener('blur', () => delete editor.dataset.tabLeaves);

  loadExample(EXAMPLES[0]);
}

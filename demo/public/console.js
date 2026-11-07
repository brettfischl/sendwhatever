// The console's shell: the mode tabs, the shared Request/Response panel, and the views' slots.
//
// A view is a module exporting mount(slot, ctx), where slot is the empty element it fills and ctx is:
//   target        { mode: 'stub' | 'real', url, accountSlug }
//   stream        the page's EventSource on /api/stream
//   send(request) sends through the demo server, shows it in the panel, resolves to the log entry,
//                 and rejects if the demo server refused it. See parseConsoleRequest in console.ts.
//   showExchange(entry)  shows a log entry in the panel

import { api, h, showError } from './common.js';
import { mount as mountArbitrary } from './console-arbitrary.js';
import { highlightJson, MAX_HIGHLIGHT_CHARS } from './console-format.js';
import { mount as mountTables } from './console-tables.js';
import { mount as mountWebhooks } from './console-webhooks.js';

const MODES = ['arbitrary', 'webhooks'];

const requestPane = document.querySelector('#exchange-request');
const responsePane = document.querySelector('#exchange-response');
const statusLabel = document.querySelector('#exchange-status');

function startTabs() {
  const tab = (mode) => document.querySelector(`#tab-${mode}`);
  const select = (mode, { focus = false } = {}) => {
    for (const other of MODES) {
      const active = other === mode;
      tab(other).setAttribute('aria-selected', String(active));
      tab(other).tabIndex = active ? 0 : -1;
      document.querySelector(`#mode-${other}`).hidden = !active;
    }
    if (focus) tab(mode).focus();
    history.replaceState(null, '', `#${mode}`);
  };

  MODES.forEach((mode, i) => {
    tab(mode).addEventListener('click', () => select(mode));
    tab(mode).addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      select(MODES[(i + step + MODES.length) % MODES.length], { focus: true });
    });
  });
  const fromHash = () => select(MODES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'arbitrary');
  window.addEventListener('hashchange', fromHash);
  fromHash();
}

function renderTarget({ mode, url, accountSlug }) {
  const parts = [
    h('span', { className: `badge badge-${mode}` }, mode === 'stub' ? 'stub' : 'live ingest'),
    h('code', {}, url),
  ];
  if (accountSlug) parts.push(h('code', {}, `account: ${accountSlug}`));
  document.querySelector('#console-target').replaceChildren(...parts);
}

function jsonText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** Coloring makes a node per token, which a big body can't afford. */
function colored(text) {
  return text.length > MAX_HIGHLIGHT_CHARS ? text : highlightJson(text);
}

function codeBlock(...children) {
  return h('pre', { className: 'exchange-code' }, ...children);
}

function headerLines(headers) {
  return Object.entries(headers ?? {}).flatMap(([name, value]) => [
    h('span', { className: 'http-header' }, `${name}:`),
    ` ${value}\n`,
  ]);
}

function setStatus(text, kind) {
  statusLabel.textContent = text;
  statusLabel.className = kind ? `status-pill status-${kind}` : '';
}

function showExchange(entry) {
  requestPane.replaceChildren(
    codeBlock(
      h('strong', { className: `method method-${entry.method}` }, entry.method),
      ` ${entry.url}\n`,
      ...headerLines(entry.headers),
      entry.rawBody === undefined ? h('span', { className: 'exchange-note' }, '\n(no body)') : '\n',
      entry.rawBody === undefined ? null : colored(entry.rawBody),
    ),
    h(
      'p',
      { className: 'exchange-note' },
      "Node's HTTP client also adds Host, Content-Length, User-Agent, and its Accept and Sec-Fetch headers.",
    ),
  );

  if (!entry.response) {
    setStatus(`No response · ${entry.duration_ms} ms`, 'fail');
    responsePane.replaceChildren(codeBlock(entry.error ?? 'No response'));
  } else {
    const { status, statusText, headers, body } = entry.response;
    setStatus(`${status}${statusText ? ` ${statusText}` : ''} · ${entry.duration_ms} ms`, status < 400 ? 'ok' : 'fail');
    // The body is the point, and on a projector the headers would push it out of view.
    const headerCount = Object.keys(headers ?? {}).length;
    responsePane.replaceChildren(
      headerCount
        ? h(
            'details',
            { className: 'exchange-headers' },
            h('summary', {}, `Headers (${headerCount})`),
            codeBlock(...headerLines(headers)),
          )
        : '',
      codeBlock(colored(jsonText(body) ?? '')),
    );
  }
  flash();
}

function showPending() {
  setStatus('Sending…', 'pending');
  responsePane.replaceChildren(h('p', { className: 'exchange-empty' }, 'Waiting for ingest…'));
}

/** The demo server refused the request or can't be reached, so nothing reached ingest. */
function showNotSent(message) {
  setStatus('Not sent', 'fail');
  requestPane.replaceChildren(h('p', { className: 'exchange-empty' }, 'Nothing was sent to ingest.'));
  responsePane.replaceChildren(codeBlock(message));
  flash();
}

function flash() {
  for (const pane of [requestPane, responsePane]) {
    pane.scrollTop = 0;
    pane.getAnimations().forEach((animation) => animation.cancel());
    pane.classList.remove('exchange-flash');
    void pane.offsetWidth;
    pane.classList.add('exchange-flash');
  }
}

/**
 * Not api() from common.js: that sets fetch's keepalive option, which caps a body at 64 KB, and
 * a demo payload can be bigger than that.
 */
async function send(request) {
  showPending();
  let response;
  let data;
  try {
    response = await fetch('/api/console/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    data = await response.json();
  } catch {
    const error = new Error("Couldn't reach the demo server. Is it still running?");
    showNotSent(error.message);
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error ?? `The demo server answered ${response.status}`);
    showNotSent(error.message);
    throw error;
  }
  showExchange(data);
  return data;
}

/** A view that fails to start shouldn't take the rest of the console down with it. */
function mountView(mount, slot, ctx) {
  try {
    mount(slot, ctx);
  } catch (error) {
    console.error(error);
    slot.replaceChildren(h('p', { className: 'exchange-empty' }, `This view failed to start: ${error.message}`));
  }
}

async function start() {
  startTabs();
  const target = await api('GET', '/api/meta').catch((error) => {
    showError(error);
    return { mode: 'unknown', url: 'unknown', accountSlug: undefined };
  });
  renderTarget(target);
  const ctx = { target, stream: new EventSource('/api/stream'), send, showExchange };
  mountView(mountArbitrary, document.querySelector('#mode-arbitrary'), ctx);
  mountView(mountWebhooks, document.querySelector('#webhooks-slot'), ctx);
  mountView(mountTables, document.querySelector('#tables-slot'), ctx);
}

start();

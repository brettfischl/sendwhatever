// Shared by every page: the API helper, DOM helper, live updates, and the request log panel.
// Text from users only ever reaches the page through h(), which uses text nodes, never innerHTML.

export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    keepalive: true,
    ...(method === 'POST'
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed with ${response.status}`);
  return data;
}

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return element;
}

export function showError(error) {
  const toast = document.querySelector('#toast');
  toast.textContent = error.message;
  toast.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => (toast.hidden = true), 5000);
}

/** Wraps an event handler so a failed action shows a message instead of disappearing. */
export function guarded(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      showError(error);
    }
  };
}

export function formatDateTime(iso, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function statusBadge(status) {
  return h('span', { className: `badge badge-${status}` }, status);
}

/** Registers a callback for session changes, collapsing a burst into one call. */
export function onSessionChange(stream, callback) {
  let pending = false;
  stream.addEventListener('session', () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      callback();
    }, 150);
  });
}

export function startPage() {
  const stream = new EventSource('/api/stream');
  startLogPanel(stream);
  return stream;
}

function startLogPanel(stream) {
  const list = document.querySelector('#log-list');
  const empty = document.querySelector('#log-empty');
  const count = document.querySelector('#log-count');
  let shown = new Set();

  const update = () => {
    empty.hidden = shown.size > 0;
    count.textContent = shown.size === 1 ? '1 request' : `${shown.size} requests`;
  };
  const add = (entry) => {
    if (shown.has(entry.id)) return;
    shown.add(entry.id);
    list.prepend(renderEntry(entry));
    update();
  };
  const clear = () => {
    shown = new Set();
    list.replaceChildren();
    update();
  };

  stream.addEventListener('log', (event) => add(JSON.parse(event.data)));
  stream.addEventListener('log-cleared', clear);

  document.querySelector('#log-clear').addEventListener('click', guarded(() => api('DELETE', '/api/log')));

  api('GET', '/api/meta').then(renderTarget).catch(showError);
  api('GET', '/api/log')
    .then((entries) => entries.forEach(add))
    .catch(showError);
  update();
}

function renderTarget({ mode, url, accountSlug }) {
  const target = document.querySelector('#log-target');
  target.replaceChildren(
    h('span', { className: `badge badge-${mode}` }, mode === 'stub' ? 'stub' : 'live ingest'),
    h('code', {}, url),
    accountSlug ? h('code', {}, `X-Account-Slug: ${accountSlug}`) : null,
  );
}

function renderEntry(entry) {
  const status = entry.response ? entry.response.status : 'ERR';
  const ok = entry.response && entry.response.status < 400;
  const path = new URL(entry.url).pathname;

  return h(
    'details',
    { className: `log-entry ${ok ? 'log-ok' : 'log-fail'}` },
    h(
      'summary',
      {},
      h('span', { className: `method method-${entry.method}` }, entry.method),
      h('span', { className: 'log-path' }, path),
      h('span', { className: 'log-status' }, String(status)),
      h('span', { className: 'log-label' }, entry.label),
      h('time', {}, new Date(entry.at).toLocaleTimeString()),
    ),
    h(
      'div',
      { className: 'log-detail' },
      section('Request', `${entry.method} ${entry.url}\n${formatHeaders(entry.headers)}`),
      section('Body', entry.rawBody ?? JSON.stringify(entry.body, null, 2)),
      entry.response
        ? section(`Response ${entry.response.status} · ${entry.duration_ms} ms`, JSON.stringify(entry.response.body, null, 2))
        : section(`No response · ${entry.duration_ms} ms`, entry.error),
    ),
  );
}

function formatHeaders(headers) {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

function section(title, content) {
  return h('div', {}, h('h4', {}, title), h('pre', {}, content));
}

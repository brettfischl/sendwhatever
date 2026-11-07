// The live tables panel. Loading this script defines <sw-live-tables>, which polls while it's on the page.
//
// Table names, column names, values, and quarantine details all come from client payloads. They reach
// the page only through h(), which uses text nodes and properties, never HTML.
import { h } from './common.js';
import { createTracker, HIGHLIGHT_MS } from './tables-tracker.js';

const POLL_MS = 1500;
const STYLESHEET = '/assets/tables-panel.css';

/** Platform columns go last, so the audience reads the data first. */
const PLATFORM_ORDER = new Map([['_deleted_at', 1], ['_event_seq', 2]]);
const isIdColumn = (name) => name === 'id';

const STATUS_LABELS = {
  queued: 'Queued',
  adapter_generating: 'Generating adapter',
  waiting: 'Waiting for adapter',
  quarantined: 'Quarantined',
  written: 'Written',
};

/** Starts a highlight part-way through, so a redraw doesn't restart it. */
function flash(element, since, now) {
  if (since === null) return element;
  element.classList.add('flash');
  element.style.animationDelay = `${since - now}ms`;
  element.style.animationDuration = `${HIGHLIGHT_MS}ms`;
  return element;
}

function displayColumns(columns) {
  return columns
    .map((column, index) => ({ ...column, index }))
    .sort((a, b) => {
      const rank = (name) => (isIdColumn(name) ? -1 : (PLATFORM_ORDER.get(name) ?? 0));
      return rank(a.name) - rank(b.name) || a.index - b.index;
    });
}

function plural(count, one, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function renderCell(column, row, now) {
  const value = row.values[column.index];
  const classes = ['cell'];
  if (PLATFORM_ORDER.has(column.name)) classes.push('platform');
  if (column.name === '_event_seq') classes.push('seq');
  if (value === null) classes.push('null');
  const cell = h('td', { className: classes.join(' '), title: value ?? 'null' }, value ?? 'null');
  return flash(cell, column.since, now);
}

function renderRow(row, columns, now) {
  const changed = row.since !== null && row.kind !== 'deleted' ? h('span', { className: `badge badge-${row.kind}` }, row.kind) : null;
  const deleted = row.deleted ? h('span', { className: 'badge badge-deleted' }, 'deleted') : null;
  const cells = columns.map((column) => renderCell(column, row, now));
  cells[0]?.prepend(...[changed, deleted].filter(Boolean));
  const element = h('tr', { className: row.deleted ? 'row-deleted' : '' }, cells);
  return flash(element, row.since, now);
}

function renderTable(table, now) {
  // A new table's columns are all new, so a badge on each would only add noise.
  const columns = displayColumns(table.columns).map((column) =>
    column.since === table.since ? { ...column, since: null } : column,
  );
  const dataColumns = table.columns.filter(({ name }) => !PLATFORM_ORDER.has(name)).length;
  const counts = [plural(table.rowCount, 'row'), table.deletedCount > 0 ? `${table.deletedCount.toLocaleString()} deleted` : null, plural(dataColumns, 'column')];

  const head = h(
    'tr',
    {},
    columns.map((column) =>
      flash(
        h(
          'th',
          { className: PLATFORM_ORDER.has(column.name) ? 'platform' : '', scope: 'col' },
          h('span', { className: 'column-name' }, column.name, column.since !== null ? h('span', { className: 'badge badge-new' }, 'new') : null),
          h('span', { className: 'column-type' }, column.type),
        ),
        column.since,
        now,
      ),
    ),
  );

  const body = table.rows.length > 0
    ? table.rows.map((row) => renderRow(row, columns, now))
    : [h('tr', {}, h('td', { className: 'no-rows', colSpan: columns.length }, 'No rows yet'))];

  return flash(
    h(
      'article',
      { className: 'table-card' },
      h(
        'header',
        {},
        h('h3', {}, table.name),
        table.since !== null ? h('span', { className: 'badge badge-new' }, 'new table') : null,
        flash(h('span', { className: 'counts' }, counts.filter(Boolean).join(' · ')), table.countSince, now),
      ),
      h('div', { className: 'grid-scroll' }, h('table', {}, h('thead', {}, head), h('tbody', {}, body))),
      table.rowCount > table.rows.length ? h('p', { className: 'more' }, `Latest ${table.rows.length} of ${table.rowCount.toLocaleString()}`) : null,
    ),
    table.since,
    now,
  );
}

function eventDetail(event) {
  if (event.status === 'written') return event.replayed ? 'Replayed from quarantine' : null;
  // A job can be retrying for one store with another's failure already open.
  const parts = event.quarantine.map(({ reason, detail }) => (detail ? `${reason}: ${detail}` : reason));
  if (event.status === 'queued' && event.attempts > 0) parts.unshift(`Attempt ${event.attempts}`);
  if (event.adapterFailure && event.status !== 'queued') parts.push(`Last attempt failed: ${event.adapterFailure}`);
  return parts.join(' · ') || null;
}

function renderEvent(event, now) {
  const path = event.source ? `/ingest/${event.source}` : '/ingest';
  const detail = eventDetail(event);
  return flash(
    h(
      'li',
      { className: 'event' },
      h('span', { className: 'event-seq' }, `#${event.seq}`),
      h('span', { className: 'event-path', title: path }, `${event.op === 'delete' ? 'DELETE ' : ''}${path}`),
      flash(h('span', { className: `status status-${event.status}` }, STATUS_LABELS[event.status] ?? event.status), event.statusSince, now),
      detail ? h('span', { className: 'event-detail', title: detail }, detail) : null,
    ),
    event.since,
    now,
  );
}

class LiveTables extends HTMLElement {
  /** Changes on every connect and disconnect, so a poll from before one knows to stop. */
  #run = 0;
  #timer;
  #controller;
  #tracker;
  #cards = new Map();
  #view;

  connectedCallback() {
    if (!this.#view) this.#build();
    this.#tracker = createTracker();
    this.#poll(++this.#run);
  }

  disconnectedCallback() {
    this.#run += 1;
    clearTimeout(this.#timer);
    this.#controller?.abort();
  }

  #build() {
    const root = this.attachShadow({ mode: 'open' });
    this.#view = {
      status: h('span', { className: 'live' }),
      notice: h('section', { className: 'notice', hidden: true }),
      problem: h('p', { className: 'problem', role: 'status', hidden: true }),
      empty: h('p', { className: 'empty', hidden: true }, 'No tables yet. Send an event and watch them appear.'),
      omitted: h('p', { className: 'more', hidden: true }),
      tables: h('div', { className: 'tables' }),
      eventsSection: h('section', { className: 'events', hidden: true, 'aria-label': 'Recent events' }),
      events: h('ol', {}),
    };
    const { status, notice, problem, empty, omitted, tables, eventsSection, events } = this.#view;
    eventsSection.append(h('h2', {}, 'Recent events'), h('p', { className: 'empty events-empty', hidden: true }, 'No events yet.'), events);
    root.append(
      h('link', { rel: 'stylesheet', href: STYLESHEET }),
      h(
        'div',
        { className: 'panel' },
        h('header', { className: 'panel-head' }, h('h2', {}, 'Live tables'), status),
        problem,
        h('div', { className: 'scroll' }, notice, empty, tables, omitted),
        eventsSection,
      ),
    );
  }

  async #poll(run) {
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const paths = ['/api/tables', '/api/tables/events'];
      const [tables, events] = await Promise.all(paths.map((path) => this.#fetch(path, controller.signal)));
      if (run !== this.#run) return;
      this.#render(tables, events);
    } catch (error) {
      if (run !== this.#run) return;
      // Keeps what's on screen, so a blip doesn't blank the panel in front of an audience.
      this.#showProblem('Can\'t reach the demo server. Retrying.');
      console.error(error);
    }
    this.#timer = setTimeout(() => this.#poll(run), POLL_MS);
  }

  async #fetch(path, signal) {
    const response = await fetch(path, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.json();
  }

  #showProblem(message) {
    this.#view.problem.textContent = message ?? '';
    this.#view.problem.hidden = !message;
  }

  #render(tables, events) {
    const now = Date.now();
    const { status } = this.#view;
    const unavailable = tables.state === 'unavailable' || events.state === 'unavailable';
    this.#showProblem(unavailable ? (tables.state === 'unavailable' ? tables.message : events.message) : null);

    if (tables.state === 'ready') {
      this.#renderTables(this.#tracker.tables(tables, now), tables.omittedTables, now);
      status.textContent = `Read-only login · ${tables.database}`;
      status.title = tables.database;
    } else if (tables.state !== 'unavailable') {
      this.#renderNotice(tables);
      status.textContent = '';
    }

    if (events.state === 'ready') this.#renderEvents(this.#tracker.events(events, now), now);
    else if (events.state !== 'unavailable') this.#view.eventsSection.hidden = true;
  }

  #renderNotice({ state, message }) {
    const { notice, empty, tables, omitted } = this.#view;
    const heading = state === 'stub' ? 'Connect a real service' : 'Tables aren\'t available yet';
    notice.replaceChildren(h('h3', {}, heading), h('p', {}, message));
    notice.hidden = false;
    empty.hidden = true;
    omitted.hidden = true;
    tables.replaceChildren();
    this.#cards.clear();
  }

  #renderTables(views, omittedTables, now) {
    const { notice, empty, tables, omitted } = this.#view;
    notice.hidden = true;
    empty.hidden = views.length > 0;
    omitted.hidden = omittedTables === 0;
    omitted.textContent = `${plural(omittedTables, 'more table')} not shown`;

    // Only a table that changed is redrawn, and the rest stay where they are in the DOM. Moving one
    // would restart its highlight and lose its sideways scroll.
    const cards = new Map();
    let cursor = tables.firstChild;
    for (const view of views) {
      const signature = JSON.stringify(view);
      const existing = this.#cards.get(view.name);
      const unchanged = existing?.signature === signature;
      const element = unchanged ? existing.element : renderTable(view, now);
      cards.set(view.name, { signature, element });
      if (element === cursor) {
        cursor = cursor.nextSibling;
      } else {
        tables.insertBefore(element, cursor);
        if (existing && !unchanged) {
          element.querySelector('.grid-scroll').scrollLeft = existing.element.querySelector('.grid-scroll').scrollLeft;
          existing.element.remove();
          if (cursor === existing.element) cursor = element.nextSibling;
        }
      }
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    this.#cards = cards;
  }

  #renderEvents(views, now) {
    const { eventsSection, events } = this.#view;
    eventsSection.hidden = false;
    eventsSection.querySelector('.events-empty').hidden = views.length > 0;
    events.replaceChildren(...views.map((view) => renderEvent(view, now)));
  }
}

if (!customElements.get('sw-live-tables')) customElements.define('sw-live-tables', LiveTables);

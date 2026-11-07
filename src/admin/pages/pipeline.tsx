import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { getPipeline, type Pipeline } from '../stats.js';
import { Layout } from '../views.js';
import {
  EVENT_STATUSES,
  getPipelineSummary,
  isUuid,
  listRecentEvents,
  listSources,
  type EventStatus,
  type EventView,
  type PipelineSummary,
} from '../../pipeline/status.js';
import { STATUS_LABELS, reasonPhrase } from '../../pipeline/labels.js';

/** Pipeline refreshes faster than the other pages: it's where people watch events arrive. */
export const PIPELINE_REFRESH_MS = 2500;
const FEED_SIZE = 25;
/** The source filter's value for events sent with no path, whose source is ''. Known gap (sw-fm4): a real source of '/' (from /ingest/%2F) shares this value. */
const NO_PATH = '/';

// Page-local styles: the shared stylesheet in views.tsx is left alone.
const CSS = `
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); vertical-align: top; }
table.grid th { color: var(--muted); font-weight: 600; }
table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; }
table.grid td.when { white-space: nowrap; font-variant-numeric: tabular-nums; }
ul.status { list-style: none; margin: 0; padding: 0; }
ul.status li { padding: 0.3rem 0; border-top: 1px solid var(--line); }
ul.status li:first-child { border-top: 0; }
.badge { display: inline-block; white-space: nowrap; border-radius: 99px; padding: 0.05rem 0.55rem; font-size: 0.8rem; font-weight: 600; border: 1px solid currentColor; }
.badge.queued { color: var(--muted); }
.badge.adapter_generating { color: var(--accent); }
.badge.waiting { color: var(--warn); }
.badge.quarantined { color: var(--live); }
.badge.written { color: var(--ok); }
.note { color: var(--muted); font-size: 0.86rem; }
form.inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.6rem; margin: 0 0 0.8rem; }
form.inline label { min-width: 10rem; }
.error { color: var(--live); font-size: 0.9rem; }
`;

export const sourceLabel = (source: string) => (source === '' ? '(no path)' : source);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** UTC to the second, so the column reads the same for everyone. */
const formatTime = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

/** The plain-English lines at the top of the page. Each only appears when its count isn't zero. */
export function statusLines(summary: PipelineSummary): string[] {
  const lines: string[] = [];
  if (summary.waitingEvents > 0) {
    lines.push(
      `${plural(summary.waitingEvents, 'event', 'events')} waiting for an adapter (${plural(summary.waitingShapeCount, 'new shape', 'new shapes')})`,
    );
  }
  if (summary.generationsRunning > 0) {
    lines.push(`AI is generating ${plural(summary.generationsRunning, 'adapter', 'adapters')}`);
  }
  if (summary.lastFailure) {
    const { detail, source, op } = summary.lastFailure;
    lines.push(`Last attempt failed: ${detail ?? 'no detail'} (${sourceLabel(source)} / ${op})`);
  }
  if (summary.awaitingApproval > 0) {
    lines.push(`${plural(summary.awaitingApproval, 'adapter', 'adapters')} awaiting approval`);
  }
  const attention = summary.quarantineByReason.filter(({ reason }) => reason !== 'unknown_fingerprint');
  const needing = attention.reduce((sum, { count }) => sum + count, 0);
  if (needing > 0) {
    const reasons = attention.map(({ reason, count }) => `${reasonPhrase(reason)} (${count})`).join('; ');
    lines.push(`${needing} need attention: ${reasons}`);
  }
  return lines;
}

/** Codes and flags only: never a payload value (§19.3). */
export function eventNotes(event: EventView): string[] {
  const notes = event.quarantine.map(({ reason }) => reasonPhrase(reason));
  if (event.adapterFailure) notes.push(event.adapterFailure);
  if (event.replayed) notes.push('replayed');
  if (event.awaitingApproval) notes.push('awaiting approval');
  return notes;
}

export interface Filters {
  /** undefined for every source; '' for events with no path. */
  source?: string;
  status?: EventStatus;
}

export function parseFilters(query: { source?: string; status?: string }): Filters {
  const filters: Filters = {};
  if (query.source) filters.source = query.source === NO_PATH ? '' : query.source;
  if (query.status && (EVENT_STATUSES as readonly string[]).includes(query.status)) {
    filters.status = query.status as EventStatus;
  }
  return filters;
}

const sourceValue = (source: string) => (source === '' ? NO_PATH : source);

const StatusSection: FC<{ summary: PipelineSummary }> = ({ summary }) => {
  const lines = statusLines(summary);
  return (
    <section class="card" data-status>
      <h2>Status</h2>
      {lines.length === 0 ? (
        <p>Nothing is waiting. Every event has been processed.</p>
      ) : (
        <ul class="status">
          {lines.map((line) => (
            <li>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
};

const EventsSection: FC<{ accountId: string; events: EventView[]; filtered: boolean }> = ({
  accountId,
  events,
  filtered,
}) => (
  <section class="card" data-events>
    <h2>Recent events</h2>
    {events.length === 0 ? (
      <p class="muted">{filtered ? 'No recent events match these filters.' : 'No recent events.'}</p>
    ) : (
      <table class="grid">
        <thead>
          <tr>
            <th>Time</th>
            <th>Source</th>
            <th>Op</th>
            <th>Status</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr data-event={event.id}>
              <td class="when">
                <a href={`/admin/accounts/${accountId}/events/${event.id}`}>
                  <time datetime={event.receivedAt}>{formatTime(event.receivedAt)}</time>
                </a>
              </td>
              <td>{sourceLabel(event.source)}</td>
              <td>{event.op}</td>
              <td>
                <span class={`badge ${event.status}`}>{STATUS_LABELS[event.status]}</span>
              </td>
              <td class="note">{eventNotes(event).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

const FiltersSection: FC<{ sources: string[]; filters: Filters }> = ({ sources, filters }) => (
  <section class="card" data-filters>
    <h2>Filters</h2>
    <form class="inline" method="get">
      <label>
        Source
        <select name="source">
          <option value="" selected={filters.source === undefined}>
            All sources
          </option>
          {sources.map((source) => (
            <option value={sourceValue(source)} selected={filters.source === source}>
              {sourceLabel(source)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select name="status">
          <option value="" selected={filters.status === undefined}>
            All
          </option>
          {EVENT_STATUSES.map((status) => (
            <option value={status} selected={filters.status === status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" class="quiet">
        Apply
      </button>
    </form>
  </section>
);

const LookupSection: FC<{ error?: string; value?: string }> = ({ error, value }) => (
  <section class="card" data-lookup>
    <h2>Look up an event ID</h2>
    <form class="inline" method="get">
      <label>
        Event ID
        <input
          name="event"
          required
          pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
          placeholder="00000000-0000-0000-0000-000000000000"
          value={value}
          size={38}
        />
      </label>
      <button type="submit" class="quiet">
        Look up
      </button>
    </form>
    {error && <p class="error">{error}</p>}
  </section>
);

export const QueueSection: FC<{ pipeline: Pipeline }> = ({ pipeline }) => (
  <>
    <section class="card">
      <h2>Queue depth</h2>
      <p>
        <strong data-depth>{pipeline.depth}</strong> jobs queued. Oldest job:{' '}
        <strong data-oldest>
          {pipeline.oldestAgeSeconds === null ? '—' : formatAge(pipeline.oldestAgeSeconds)}
        </strong>
      </p>
      {pipeline.depthByKind.length > 0 && (
        <table class="grid">
          <thead>
            <tr>
              <th>Kind</th>
              <th class="num">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {pipeline.depthByKind.map((row) => (
              <tr>
                <td>{row.kind}</td>
                <td class="num">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    <section class="card">
      <h2>Retries</h2>
      {pipeline.retries.length === 0 ? (
        <p class="muted">No jobs have been retried.</p>
      ) : (
        <table class="grid">
          <thead>
            <tr>
              <th>Job</th>
              <th>Kind</th>
              <th class="num">Attempts</th>
              <th class="num">Age</th>
            </tr>
          </thead>
          <tbody>
            {pipeline.retries.map((job) => (
              <tr>
                <td>
                  <code>{job.id.slice(0, 8)}</code>
                </td>
                <td>{job.kind}</td>
                <td class="num">{job.attempts}</td>
                <td class="num">{formatAge(job.ageSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </>
);

export const PipelineRegion: FC<{
  accountId: string;
  summary: PipelineSummary;
  sources: string[];
  events: EventView[];
  filters: Filters;
  pipeline: Pipeline;
  lookup?: { error: string; value: string };
}> = ({ accountId, summary, sources, events, filters, pipeline, lookup }) => (
  <>
    <StatusSection summary={summary} />
    {sources.length === 0 ? (
      <section class="card" data-events>
        <h2>Recent events</h2>
        <p data-empty>
          No events yet. <a href={`/admin/accounts/${accountId}/connect`}>Send your first one</a>.
        </p>
      </section>
    ) : (
      <>
        <EventsSection
          accountId={accountId}
          events={events}
          filtered={filters.source !== undefined || filters.status !== undefined}
        />
        <FiltersSection sources={sources} filters={filters} />
        <LookupSection error={lookup?.error} value={lookup?.value} />
      </>
    )}
    <QueueSection pipeline={pipeline} />
  </>
);

export const pipelineRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { appDb } = c.get('deps');

  let lookup: { error: string; value: string } | undefined;
  const wanted = c.req.query('event');
  if (wanted !== undefined) {
    const id = wanted.trim();
    if (isUuid(id)) return c.redirect(`/admin/accounts/${account.id}/events/${id.toLowerCase()}`, 303);
    lookup = { error: "That isn't an event ID. Event IDs look like 1b4e28ba-2fa1-11d2-883f-0016d3cca427.", value: wanted.slice(0, 64) };
  }

  const filters = parseFilters({ source: c.req.query('source'), status: c.req.query('status') });
  const [summary, sources, events, pipeline] = await Promise.all([
    getPipelineSummary(appDb, account.id),
    listSources(appDb, account.id),
    listRecentEvents(appDb, { accountId: account.id, limit: FEED_SIZE, ...filters }),
    getPipeline(appDb, account.id),
  ]);
  const region = (
    <PipelineRegion
      accountId={account.id}
      summary={summary}
      sources={sources}
      events={events}
      filters={filters}
      pipeline={pipeline}
      lookup={lookup}
    />
  );
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Pipeline" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Pipeline: {account.slug}</h1>
        <p class="muted">
          Where each event is: arrived, waiting for an adapter, written, or stuck and why. This page refreshes itself.
        </p>
      </section>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <LiveRegion interval={PIPELINE_REFRESH_MS}>{region}</LiveRegion>
    </Layout>
  );
};

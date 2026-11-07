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
import {
  Callout,
  DataTable,
  EmptyState,
  Icon,
  PageHeader,
  pipelineStatus,
  RelativeTime,
  Section,
  StatGrid,
  StatTile,
  StatusPill,
  Toolbar,
} from '../ui/index.js';

/** Pipeline refreshes faster than the other pages: it's where people watch events arrive. */
export const PIPELINE_REFRESH_MS = 2500;
const FEED_SIZE = 25;
/** The source filter's value for events sent with no path, whose source is ''. Known gap (sw-fm4): a real source of '/' (from /ingest/%2F) shares this value. */
const NO_PATH = '/';

export const sourceLabel = (source: string) => (source === '' ? '(no path)' : source);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
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

/** Quarantined events that aren't simply waiting for an adapter. */
export const needsAttention = (summary: PipelineSummary) =>
  summary.quarantineByReason
    .filter(({ reason }) => reason !== 'unknown_fingerprint')
    .reduce((sum, { count }) => sum + count, 0);

const StatusSection: FC<{ accountId: string; summary: PipelineSummary }> = ({ accountId, summary }) => {
  const attention = needsAttention(summary);
  const base = `/admin/accounts/${accountId}/pipeline`;
  const allZero =
    summary.waitingEvents === 0 && summary.generationsRunning === 0 && attention === 0 && summary.awaitingApproval === 0;
  const reasons = summary.quarantineByReason
    .filter(({ reason }) => reason !== 'unknown_fingerprint')
    .map(({ reason, count }) => `${reasonPhrase(reason)} (${count})`)
    .join('; ');
  return (
    <div data-status class="stack">
      <StatGrid>
        <StatTile
          label="Waiting for adapter"
          value={summary.waitingEvents}
          tone="info"
          href={`${base}?status=waiting`}
          hint={plural(summary.waitingShapeCount, 'new shape', 'new shapes')}
        />
        <StatTile
          label="AI generating"
          value={summary.generationsRunning}
          tone="progress"
          href={`${base}?status=adapter_generating`}
          hint={summary.generationsRunning === 1 ? 'adapter' : 'adapters'}
        />
        <StatTile
          label="Needs attention"
          value={attention}
          tone="warning"
          href={`${base}?status=quarantined`}
          hint={attention > 0 ? reasons : 'events'}
        />
        <StatTile label="Awaiting approval" value={summary.awaitingApproval} tone="info" hint="validated adapters" />
      </StatGrid>
      {summary.lastFailure && (
        <Callout variant="warning" title="Last generation failed">
          {summary.lastFailure.detail ?? 'No detail'}{' '}
          <span class="muted">
            ({sourceLabel(summary.lastFailure.source)} / {summary.lastFailure.op},{' '}
            <RelativeTime value={summary.lastFailure.finishedAt} />)
          </span>
        </Callout>
      )}
      {allZero && !summary.lastFailure && (
        <p class="status-line">
          <Icon name="check-circle" size={16} />
          Nothing is waiting. Every event has been processed.
        </p>
      )}
    </div>
  );
};

const FilterBar: FC<{ sources: string[]; filters: Filters }> = ({ sources, filters }) => (
  <Toolbar label="Filter and look up events" attrs={{ 'data-filters': '' }}>
    <form method="get" aria-label="Filter events">
      <span class="toolbar-label">Filter</span>
      <select name="source" aria-label="Source" onchange="this.form.submit()">
        <option value="" selected={filters.source === undefined}>
          All sources
        </option>
        {sources.map((source) => (
          <option value={sourceValue(source)} selected={filters.source === source}>
            {sourceLabel(source)}
          </option>
        ))}
      </select>
      <select name="status" aria-label="Status" onchange="this.form.submit()">
        <option value="" selected={filters.status === undefined}>
          All statuses
        </option>
        {EVENT_STATUSES.map((status) => (
          <option value={status} selected={filters.status === status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit" class="btn btn-secondary btn-sm">
          Apply
        </button>
      </noscript>
      {(filters.source !== undefined || filters.status !== undefined) && (
        <a class="btn btn-ghost btn-sm" href="?">
          Clear
        </a>
      )}
    </form>
    <form method="get" data-lookup aria-label="Look up an event">
      <input
        name="event"
        aria-label="Event ID"
        required
        pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
        placeholder="Look up an event ID"
      />
      <button type="submit" class="btn btn-secondary btn-sm">
        <Icon name="search" size={14} />
        Look up
      </button>
    </form>
  </Toolbar>
);

const EventsSection: FC<{ accountId: string; events: EventView[]; filtered: boolean; now: Date }> = ({
  accountId,
  events,
  filtered,
  now,
}) => {
  const href = (event: EventView) => `/admin/accounts/${accountId}/events/${event.id}`;
  return (
    <Section
      title="Recent events"
      flush
      id="feed"
      actions={
        <span class="feed-meta">
          <span class="live-dot" aria-hidden="true" />
          Live · last {FEED_SIZE}
        </span>
      }
    >
      <div data-events>
        <DataTable
          rows={events}
          caption="Recent events"
          rowHref={href}
          empty={
            <EmptyState
              icon={filtered ? 'search' : 'inbox'}
              title={filtered ? 'No recent events match these filters.' : 'No recent events.'}
            />
          }
          columns={[
            {
              header: 'Event',
              mono: true,
              width: '110px',
              cell: (event) => (
                <a href={href(event)} data-event={event.id} aria-label={`Event ${event.id}`}>
                  {event.id.slice(0, 8)}
                </a>
              ),
            },
            { header: 'Source', cell: (event) => sourceLabel(event.source) },
            { header: 'Op', width: '90px', cell: (event) => event.op },
            {
              header: 'Status',
              width: '190px',
              cell: (event) => {
                const { variant, label } = pipelineStatus(event.status);
                return <StatusPill variant={variant}>{label}</StatusPill>;
              },
            },
            {
              header: 'Note',
              // The pill already says "Waiting for adapter", so the matching reason would only repeat it.
              cell: (event) => (
                <span class="cell-note">
                  {eventNotes({ ...event, quarantine: event.quarantine.filter((q) => q.reason !== 'unknown_fingerprint') }).join(', ')}
                </span>
              ),
            },
            {
              header: 'Received',
              align: 'right',
              width: '110px',
              cell: (event) => <RelativeTime value={event.receivedAt} now={now} />,
            },
          ]}
        />
      </div>
    </Section>
  );
};

export const QueueSection: FC<{ pipeline: Pipeline }> = ({ pipeline }) => (
  <Section
    title="Queue"
    description={
      <>
        <strong data-depth>{pipeline.depth}</strong> {pipeline.depth === 1 ? 'job' : 'jobs'} queued · oldest{' '}
        <strong data-oldest>
          {pipeline.oldestAgeSeconds === null ? '—' : formatAge(pipeline.oldestAgeSeconds)}
        </strong>{' '}
        · {plural(pipeline.retries.length, 'retry', 'retries')}
      </>
    }
    flush
    compact
  >
    {pipeline.depthByKind.length === 0 && pipeline.retries.length === 0 ? null : (
      <>
        {pipeline.depthByKind.length > 0 && (
          <DataTable
            rows={pipeline.depthByKind}
            caption="Queue depth by kind"
            columns={[
              { header: 'Kind', cell: (row) => row.kind },
              { header: 'Jobs', align: 'right', cell: (row) => row.count },
            ]}
          />
        )}
        {pipeline.retries.length > 0 && (
          <DataTable
            rows={pipeline.retries}
            caption="Retries"
            columns={[
              { header: 'Retried job', mono: true, cell: (job) => job.id.slice(0, 8) },
              { header: 'Kind', cell: (job) => job.kind },
              { header: 'Attempts', align: 'right', cell: (job) => job.attempts },
              { header: 'Age', align: 'right', cell: (job) => formatAge(job.ageSeconds) },
            ]}
          />
        )}
      </>
    )}
  </Section>
);

export const PipelineRegion: FC<{
  accountId: string;
  summary: PipelineSummary;
  sources: string[];
  events: EventView[];
  filters: Filters;
  pipeline: Pipeline;
  now?: Date;
}> = ({ accountId, summary, sources, events, filters, pipeline, now = new Date() }) => (
  <>
    <StatusSection accountId={accountId} summary={summary} />
    {sources.length === 0 ? (
      <Section title="Recent events">
        <div data-events data-empty>
          <EmptyState
            title="No events yet"
            description="Send your first event and it will show up here within a few seconds."
            action={
              <a class="btn btn-primary" href={`/admin/accounts/${accountId}/connect`}>
                Send your first one
              </a>
            }
          />
        </div>
      </Section>
    ) : (
      <div class="stack">
        <FilterBar sources={sources} filters={filters} />
        <EventsSection
          accountId={accountId}
          events={events}
          filtered={filters.source !== undefined || filters.status !== undefined}
          now={now}
        />
      </div>
    )}
    <QueueSection pipeline={pipeline} />
  </>
);

export const pipelineRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { appDb } = c.get('deps');

  // A failed lookup is shown once, on the full page, above the live region. The refresh requests the same
  // URL, so a fragment request ignores `event`; otherwise the error would come back every 2.5s.
  let lookup: { error: string } | undefined;
  const wanted = isFragmentRequest(c) ? undefined : c.req.query('event');
  if (wanted !== undefined) {
    const id = wanted.trim();
    if (isUuid(id)) return c.redirect(`/admin/accounts/${account.id}/events/${id.toLowerCase()}`, 303);
    lookup = { error: "That isn't an event ID. Event IDs look like 1b4e28ba-2fa1-11d2-883f-0016d3cca427." };
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
    />
  );
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Pipeline" user={c.get('user')} csrf={c.get('csrf')}>
      <PageHeader
        breadcrumbs={[
          { label: 'Accounts', href: '/admin' },
          { label: account.slug, href: `/admin/accounts/${account.id}` },
          { label: 'Pipeline' },
        ]}
        title="Pipeline"
        description="Live status of every event: arrived, waiting for an adapter, written, or stuck and why."
      />
      {lookup && <Callout variant="danger">{lookup.error}</Callout>}
      <LiveRegion interval={PIPELINE_REFRESH_MS}>{region}</LiveRegion>
    </Layout>
  );
};

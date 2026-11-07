// The event explorer (PRD §19): what arrived, what happened to it, and, behind a deliberate POST, what
// was in it. Payloads can hold personal data and customer secrets (§19.3), so the event page never
// reads `events.body` or `events.request`. Only the payload view does.
import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import { HttpError } from '../../http/deps.js';
import { getEvent, isUuid, type EventStatus, type EventView } from '../../pipeline/status.js';
import { reasonLabel } from '../../pipeline/labels.js';
import type { AccountAccess, AdminEnv } from '../index.js';
import type { SessionUser } from '../sessions.js';
import { Form, Layout } from '../views.js';
import {
  Callout,
  DataTable,
  EmptyState,
  KeyValueList,
  PageHeader,
  pipelineStatus,
  RelativeTime,
  Section,
  StatusPill,
} from '../ui/index.js';
import { fullTime } from '../ui/format.js';

/** The most of a body the payload view shows. */
export const PAYLOAD_LIMIT = 100 * 1024;

// Only the reason is shown. Details can quote error messages, which may echo payload values.

export interface ReplayEntry {
  status: string;
  attemptedAt: string;
}

const eventPath = (accountId: string, eventId: string) => `/admin/accounts/${accountId}/events/${eventId}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

export interface RenderedBody {
  text: string;
  truncated: boolean;
  /** True when the text is JSON re-serialized for display, so it may differ from the bytes sent. */
  reformatted: boolean;
}

/** The body as text: pretty-printed JSON when it parses, else UTF-8, cut to PAYLOAD_LIMIT bytes. */
export function renderBody(body: Buffer): RenderedBody {
  if (body.length > PAYLOAD_LIMIT) {
    // Truncated bodies are not pretty-printed (the cut would usually leave invalid JSON anyway), so this
    // branch shows the first PAYLOAD_LIMIT bytes as sent.
    return {
      text: new TextDecoder('utf-8').decode(body.subarray(0, PAYLOAD_LIMIT)),
      truncated: true,
      reformatted: false,
    };
  }
  const text = new TextDecoder('utf-8').decode(body);
  try {
    // Not as sent: JSON.parse/stringify loses precision on large integers and drops duplicate keys.
    return { text: JSON.stringify(JSON.parse(text), null, 2), truncated: false, reformatted: true };
  } catch {
    return { text, truncated: false, reformatted: false };
  }
}

/** Body size and replay history. Neither reads the body or `replay_log.detail`. */
async function loadExtras(
  db: Parameters<typeof getEvent>[0],
  accountId: string,
  eventId: string,
): Promise<{ size: number; replays: ReplayEntry[] }> {
  const [size, replays] = await Promise.all([
    db.query<{ size: number }>(
      'SELECT octet_length(body)::int AS size FROM events WHERE account_id = $1 AND id = $2',
      [accountId, eventId],
    ),
    db.query<{ status: string; attempted_at: Date }>(
      `SELECT r.status, r.attempted_at FROM replay_log r
         JOIN quarantine q ON q.account_id = r.account_id AND q.id = r.quarantine_id
        WHERE q.account_id = $1 AND q.event_id = $2
        ORDER BY r.attempted_at, r.id`,
      [accountId, eventId],
    ),
  ]);
  return {
    size: size.rows[0]?.size ?? 0,
    replays: replays.rows.map((r) => ({ status: r.status, attemptedAt: r.attempted_at.toISOString() })),
  };
}

export const EventPage: FC<{
  user: SessionUser;
  csrf: string | undefined;
  account: AccountAccess;
  event: EventView;
  size: number;
  replays: ReplayEntry[];
}> = ({ user, csrf, account, event, size, replays }) => {
  const { variant, label } = pipelineStatus(event.status);
  const pipelineHref = `/admin/accounts/${account.id}/pipeline`;
  return (
    <Layout title={`Event ${event.id.slice(0, 8)}`} user={user} csrf={csrf}>
      <PageHeader
        breadcrumbs={[
          { label: 'Accounts', href: '/admin' },
          { label: account.slug, href: `/admin/accounts/${account.id}` },
          { label: 'Pipeline', href: pipelineHref },
          { label: `Event ${event.id.slice(0, 8)}` },
        ]}
        title={
          <>
            Event <code>{event.id.slice(0, 8)}</code>
            <span data-status={event.status}>
              <StatusPill variant={variant}>{label}</StatusPill>
            </span>
            {event.replayed && (
              <span class="tag" data-replayed>
                replayed
              </span>
            )}
            {event.awaitingApproval && (
              <span class="tag" data-awaiting-approval>
                awaiting approval
              </span>
            )}
          </>
        }
        description={
          <>
            Received <RelativeTime value={event.receivedAt} /> from{' '}
            {event.source === '' ? '(no path)' : <code>{event.source}</code>}
          </>
        }
      />
      <div class="stack">
        {event.quarantine.length > 0 && (
          <Callout variant={event.status === 'waiting' ? 'info' : 'warning'} title="Why it's held">
            <ul data-quarantine class="callout-list">
              {event.quarantine.map((q) => (
                <li data-reason={q.reason}>
                  {reasonLabel(q.reason)} <span class="muted">({q.reason})</span>
                </li>
              ))}
            </ul>
          </Callout>
        )}

        <Section title="Details">
          <KeyValueList
            items={[
              { label: 'Event ID', attrs: { 'data-field': 'id' }, value: <code>{event.id}</code> },
              {
                label: 'Source',
                attrs: { 'data-field': 'source' },
                value: event.source === '' ? '(no path)' : <code>{event.source}</code>,
              },
              { label: 'Operation', attrs: { 'data-field': 'op' }, value: event.op },
              {
                label: 'Received',
                attrs: { 'data-field': 'received' },
                value: (
                  <>
                    <RelativeTime value={event.receivedAt} />
                    <span class="sub">{fullTime(event.receivedAt)}</span>
                  </>
                ),
              },
              {
                label: 'Fingerprint',
                attrs: { 'data-field': 'fingerprint' },
                value: event.fingerprint === null ? 'None (malformed body)' : <code>{event.fingerprint}</code>,
              },
              { label: 'Body size', attrs: { 'data-field': 'size' }, value: formatBytes(size) },
              {
                label: 'Processing',
                attrs: { 'data-field': 'job' },
                value:
                  event.attempts === null
                    ? 'Processed'
                    : `Still queued (${event.attempts} ${event.attempts === 1 ? 'attempt' : 'attempts'} so far)`,
              },
              ...(event.adapterFailure !== null
                ? [
                    {
                      label: 'Last generation failure',
                      attrs: { 'data-field': 'adapter-failure' },
                      value: event.adapterFailure,
                    },
                  ]
                : []),
            ]}
          />
        </Section>

        <Section title="Replay history" flush>
          <div data-replays>
            <DataTable
              rows={replays}
              caption="Replay history"
              empty={<EmptyState compact title="This event hasn't been replayed." />}
              columns={[
                { header: 'Attempted', cell: (r) => <RelativeTime value={r.attemptedAt} /> },
                { header: 'Result', cell: (r) => r.status },
              ]}
            />
          </div>
        </Section>

        <Section
          title="Payload"
          description="The body and request headers can hold personal data and customer secrets, so they're only shown when you ask for them."
        >
          {account.readOnly ? (
            <p class="muted">Super admins have read-only access, so they can't view payloads.</p>
          ) : (
            <Form action={`${eventPath(account.id, event.id)}/payload`} csrf={csrf}>
              <button type="submit" class="btn btn-secondary">
                View payload and headers
              </button>
            </Form>
          )}
        </Section>
      </div>
    </Layout>
  );
};

export const PayloadPage: FC<{
  user: SessionUser;
  csrf: string | undefined;
  account: AccountAccess;
  eventId: string;
  size: number;
  body: RenderedBody;
  request: { method: string; path: string; query: string; headers: [string, string][] };
}> = ({ user, csrf, account, eventId, size, body, request }) => (
  <Layout title={`Payload ${eventId.slice(0, 8)}`} user={user} csrf={csrf}>
    <PageHeader
      breadcrumbs={[
        { label: 'Accounts', href: '/admin' },
        { label: account.slug, href: `/admin/accounts/${account.id}` },
        { label: 'Pipeline', href: `/admin/accounts/${account.id}/pipeline` },
        { label: `Event ${eventId.slice(0, 8)}`, href: eventPath(account.id, eventId) },
        { label: 'Payload' },
      ]}
      title="Payload"
      description={
        <>
          For event{' '}
          <a href={eventPath(account.id, eventId)}>
            <code>{eventId}</code>
          </a>
          . Authorization headers and the key parameter are removed before an event is stored.
        </>
      }
    />
    <div class="stack">
      <Section title="Request">
        <KeyValueList
          items={[
            { label: 'Method', attrs: { 'data-field': 'method' }, value: request.method },
            { label: 'Path', attrs: { 'data-field': 'path' }, value: <code>{request.path}</code> },
            {
              label: 'Query string',
              attrs: { 'data-field': 'query' },
              value: request.query === '' ? '(none)' : <code>{request.query}</code>,
            },
          ]}
        />
      </Section>
      <Section title="Headers" flush={request.headers.length > 0}>
        {request.headers.length === 0 ? (
          <p class="muted">No headers were stored.</p>
        ) : (
          <div data-headers>
            <DataTable
              rows={request.headers}
              caption="Request headers"
              columns={[
                { header: 'Name', mono: true, width: '35%', cell: ([name]) => <code>{name}</code> },
                { header: 'Value', mono: true, cell: ([, value]) => <code>{value}</code> },
              ]}
            />
          </div>
        )}
      </Section>
      <Section title="Body" description={`${size.toLocaleString('en-US')} bytes`}>
        <div class="stack">
          {body.truncated && (
            <Callout variant="warning">
              <span data-truncated>
                Truncated: showing the first {PAYLOAD_LIMIT.toLocaleString('en-US')} of {size.toLocaleString('en-US')}{' '}
                bytes
              </span>
            </Callout>
          )}
          {body.reformatted && (
            <p class="muted" data-reformatted>
              Reformatted as JSON for display; large numbers and duplicate keys may differ from what was sent.
            </p>
          )}
          <pre class="payload-body" data-body>
            {body.text}
          </pre>
        </div>
      </Section>
    </div>
  </Layout>
);

/** GET /admin/accounts/:accountId/events/:eventId */
export const eventRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const eventId = c.req.param('eventId') ?? '';
  if (!isUuid(eventId)) throw new HttpError(404, 'Page not found');
  const db = c.get('deps').appDb;
  const event = await getEvent(db, account.id, eventId);
  if (!event) throw new HttpError(404, 'Page not found');
  const { size, replays } = await loadExtras(db, account.id, event.id);
  return c.html(
    <EventPage
      user={c.get('user')!}
      csrf={c.get('csrf')}
      account={account}
      event={event}
      size={size}
      replays={replays}
    />,
  );
};

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** POST /admin/accounts/:accountId/events/:eventId/payload: the deliberate view of what was sent. */
export const eventPayloadRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const eventId = c.req.param('eventId') ?? '';
  if (!isUuid(eventId)) throw new HttpError(404, 'Page not found');
  const row = (
    await c.get('deps').appDb.query<{ body: Buffer; request: Record<string, unknown> | null }>(
      'SELECT body, request FROM events WHERE account_id = $1 AND id = $2',
      [account.id, eventId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, 'Page not found');

  const stored = row.request ?? {};
  const rawHeaders = stored.headers;
  const headers =
    rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
      ? Object.entries(rawHeaders as Record<string, unknown>)
          .map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : JSON.stringify(value)])
          .sort(([a], [b]) => a.localeCompare(b))
      : [];

  return c.html(
    <PayloadPage
      user={c.get('user')!}
      csrf={c.get('csrf')}
      account={account}
      eventId={eventId}
      size={row.body.length}
      body={renderBody(row.body)}
      request={{ method: str(stored.method), path: str(stored.path), query: str(stored.query), headers }}
    />,
  );
};

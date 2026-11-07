// The event explorer (PRD §19): what arrived, what happened to it, and, behind a deliberate POST, what
// was in it. Payloads can hold personal data and customer secrets (§19.3), so the event page never
// reads `events.body` or `events.request`. Only the payload view does.
import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import { HttpError } from '../../http/deps.js';
import { getEvent, isUuid, type EventStatus, type EventView } from '../../pipeline/status.js';
import type { AccountAccess, AdminEnv } from '../index.js';
import type { SessionUser } from '../sessions.js';
import { Form, Layout } from '../views.js';

/** The most of a body the payload view shows. */
export const PAYLOAD_LIMIT = 100 * 1024;

// The same labels as the Pipeline v2 feed.
export const STATUS_LABELS: Record<EventStatus, string> = {
  queued: 'Queued',
  adapter_generating: 'AI generating',
  waiting: 'Waiting for adapter',
  quarantined: 'Needs attention',
  written: 'Written',
};

// Only the reason is shown. Details can quote error messages, which may echo payload values.
export const REASON_TEXT: Record<string, string> = {
  unknown_fingerprint: 'No adapter handles this shape yet.',
  malformed: "The body isn't a JSON value the pipeline can read.",
  adapter_error: 'The adapter failed on this event.',
  schema_conflict: "The adapter's output conflicts with the existing tables.",
  write_error: "Writing to the account's store failed.",
};

// Page-local styles: the shared stylesheet in views.tsx is left alone.
const CSS = `
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0; }
dl.facts dt { color: var(--muted); font-weight: 600; font-size: 0.9rem; }
dl.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.badge { display: inline-block; border-radius: 99px; padding: 0.05rem 0.65rem; font-size: 0.85rem; font-weight: 600; border: 1px solid var(--line); background: var(--paper); }
.badge.written { color: var(--ok); }
.badge.queued, .badge.adapter_generating, .badge.waiting { color: var(--warn); }
.badge.quarantined { color: var(--live); }
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
table.grid th { color: var(--muted); font-weight: 600; }
pre.body { background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 0.6rem 0.75rem; max-height: 70vh; overflow: auto; font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.85rem; }
.notice { color: var(--warn); font-weight: 600; }
`;

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

/** The body as text: pretty-printed JSON when it parses, else UTF-8, cut to PAYLOAD_LIMIT bytes. */
export function renderBody(body: Buffer): { text: string; truncated: boolean } {
  if (body.length > PAYLOAD_LIMIT) {
    // Not pretty-printed: the cut would usually leave invalid JSON anyway, and this shows the bytes as sent.
    return { text: new TextDecoder('utf-8').decode(body.subarray(0, PAYLOAD_LIMIT)), truncated: true };
  }
  const text = new TextDecoder('utf-8').decode(body);
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), truncated: false };
  } catch {
    return { text, truncated: false };
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
}> = ({ user, csrf, account, event, size, replays }) => (
  <Layout title={`Event ${event.id.slice(0, 8)}`} user={user} csrf={csrf}>
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
    <section class="card">
      <h1>Event</h1>
      <p>
        <code>{event.id}</code>
      </p>
      <p>
        <span class={`badge ${event.status}`} data-status={event.status}>
          {STATUS_LABELS[event.status]}
        </span>
        {event.replayed && <> <span class="tag" data-replayed>replayed</span></>}
        {event.awaitingApproval && <> <span class="tag" data-awaiting-approval>awaiting approval</span></>}
      </p>
      <dl class="facts">
        <dt>Source</dt>
        <dd data-field="source">{event.source === '' ? '(no path)' : <code>{event.source}</code>}</dd>
        <dt>Operation</dt>
        <dd data-field="op">{event.op}</dd>
        <dt>Received</dt>
        <dd data-field="received">
          <time datetime={event.receivedAt}>{event.receivedAt}</time>
        </dd>
        <dt>Fingerprint</dt>
        <dd data-field="fingerprint">
          {event.fingerprint === null ? 'none (malformed body)' : <code>{event.fingerprint}</code>}
        </dd>
        <dt>Body size</dt>
        <dd data-field="size">{size.toLocaleString('en-US')} bytes</dd>
        <dt>Queue job</dt>
        <dd data-field="job">
          {event.attempts === null
            ? 'None: processing has finished.'
            : `Still queued (${event.attempts} ${event.attempts === 1 ? 'attempt' : 'attempts'} so far).`}
        </dd>
        {event.adapterFailure !== null && (
          <>
            <dt>Last generation failure</dt>
            <dd data-field="adapter-failure">{event.adapterFailure}</dd>
          </>
        )}
      </dl>
    </section>

    {event.quarantine.length > 0 && (
      <section class="card">
        <h2>Why it's held</h2>
        <ul data-quarantine>
          {event.quarantine.map((q) => (
            <li data-reason={q.reason}>
              {REASON_TEXT[q.reason] ?? 'Held for another reason.'} <span class="muted">({q.reason})</span>
            </li>
          ))}
        </ul>
      </section>
    )}

    <section class="card">
      <h2>Replay history</h2>
      {replays.length === 0 ? (
        <p class="muted">This event hasn't been replayed.</p>
      ) : (
        <table class="grid" data-replays>
          <thead>
            <tr>
              <th>Attempted</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {replays.map((r) => (
              <tr>
                <td>
                  <time datetime={r.attemptedAt}>{r.attemptedAt}</time>
                </td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>

    <section class="card">
      <h2>Payload</h2>
      <p class="muted">
        The body and request headers can hold personal data and customer secrets, so they're only shown
        when you ask for them.
      </p>
      {account.readOnly ? (
        <p class="muted">Super admins have read-only access, so they can't view payloads.</p>
      ) : (
        <Form action={`${eventPath(account.id, event.id)}/payload`} csrf={csrf}>
          <button type="submit">View payload and headers</button>
        </Form>
      )}
    </section>

    <p>
      <a href={`/admin/accounts/${account.id}/pipeline`}>Back to the pipeline</a>
    </p>
  </Layout>
);

export const PayloadPage: FC<{
  user: SessionUser;
  csrf: string | undefined;
  account: AccountAccess;
  eventId: string;
  size: number;
  body: { text: string; truncated: boolean };
  request: { method: string; path: string; query: string; headers: [string, string][] };
}> = ({ user, csrf, account, eventId, size, body, request }) => (
  <Layout title={`Payload ${eventId.slice(0, 8)}`} user={user} csrf={csrf}>
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
    <section class="card">
      <h1>Payload</h1>
      <p>
        <a href={eventPath(account.id, eventId)}>
          Event <code>{eventId}</code>
        </a>
      </p>
      <p class="muted">Authorization headers and the key parameter are removed before an event is stored.</p>
    </section>
    <section class="card">
      <h2>Request</h2>
      <dl class="facts">
        <dt>Method</dt>
        <dd data-field="method">{request.method}</dd>
        <dt>Path</dt>
        <dd data-field="path">
          <code>{request.path}</code>
        </dd>
        <dt>Query string</dt>
        <dd data-field="query">{request.query === '' ? '(none)' : <code>{request.query}</code>}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Headers</h2>
      {request.headers.length === 0 ? (
        <p class="muted">No headers were stored.</p>
      ) : (
        <table class="grid" data-headers>
          <tbody>
            {request.headers.map(([name, value]) => (
              <tr>
                <th>
                  <code>{name}</code>
                </th>
                <td>
                  <code>{value}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    <section class="card">
      <h2>Body</h2>
      <p class="muted">{size.toLocaleString('en-US')} bytes</p>
      {body.truncated && (
        <p class="notice" data-truncated>
          Truncated: showing {formatBytes(PAYLOAD_LIMIT)} of {formatBytes(size)}
        </p>
      )}
      <pre class="body" data-body>
        {body.text}
      </pre>
    </section>
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

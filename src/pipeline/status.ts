// Where each event is in the pipeline (PRD §5.2, §10, §12.1), shared by the admin and the demo console.
//
// Every query is scoped to one account, and none reads `events.body` or `events.request`, which hold
// what the client sent (§19.3). Quarantine and attempt details hold codes, never payload values.
import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'>;

export type EventStatus = 'queued' | 'adapter_generating' | 'waiting' | 'quarantined' | 'written';

export const EVENT_STATUSES: readonly EventStatus[] = ['queued', 'adapter_generating', 'waiting', 'quarantined', 'written'];

/** Quarantine reasons the adapter generator works on (§12.1). The others are left to operators. */
export const GENERATOR_REASONS: ReadonlySet<string> = new Set(['unknown_fingerprint', 'adapter_error', 'schema_conflict']);

export interface EventView {
  id: string;
  seq: string;
  source: string;
  op: string;
  fingerprint: string | null;
  receivedAt: string;
  status: EventStatus;
  /** Claims so far, while queued. The queue can't tell a running job from one in backoff. */
  attempts: number | null;
  /** Open quarantine rows. An event can have one per store (§10). */
  quarantine: { reason: string; detail: string | null }[];
  /** Why the last generation for this shape failed, if it did. */
  adapterFailure: string | null;
  /** It reached `written` through a replay, after being quarantined. */
  replayed: boolean;
  /** A validated adapter for this event's (source, op, fingerprint) is waiting on an operator. */
  awaitingApproval: boolean;
}

export interface WaitingShape {
  source: string;
  op: string;
  fingerprint: string;
  /** Events with an open `unknown_fingerprint` row for this shape. */
  events: number;
  oldestQuarantinedAt: string;
}

export interface PipelineSummary {
  /** Open quarantine rows (`released_at IS NULL`) by reason, most first. */
  quarantineByReason: { reason: string; count: number }[];
  /** Distinct events with an open `unknown_fingerprint` row. */
  waitingEvents: number;
  /** Distinct (source, op, fingerprint) among those events. */
  waitingShapeCount: number;
  /** The waiting shapes with the most events, at most 10. */
  waitingShapes: WaitingShape[];
  /** Generations in progress (`adapter_attempts.status = 'running'`). */
  generationsRunning: number;
  /** The most recent failed generation in the last 24 hours. */
  lastFailure: { source: string; op: string; detail: string | null; finishedAt: string } | null;
  /** Validated adapters that aren't active or superseded: waiting on an operator. */
  awaitingApproval: number;
}

export const DEFAULT_EVENT_LIMIT = 25;
export const MAX_EVENT_LIMIT = 100;
const MAX_DETAIL_LENGTH = 300;
const WAITING_SHAPES_SHOWN = 10;
const FAILURE_WINDOW_HOURS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * `written` means the job is gone and no quarantine row is open. That's all the schema records: a job
 * whose adapter returned no rows finishes the same way (§10.1), so it can also mean "nothing to write".
 */
export function eventStatus(row: {
  attempts: number | null;
  quarantine: { reason: string }[];
  attempt_status: string | null;
}): EventStatus {
  if (row.attempts !== null) return 'queued';
  if (row.quarantine.length === 0) return 'written';
  const reasons = row.quarantine.map(({ reason }) => reason);
  if (row.attempt_status === 'running' && reasons.some((reason) => GENERATOR_REASONS.has(reason))) {
    return 'adapter_generating';
  }
  return reasons.includes('unknown_fingerprint') ? 'waiting' : 'quarantined';
}

interface EventRow {
  id: string;
  seq: string;
  source: string;
  op: string;
  fingerprint: string | null;
  received_at: Date;
  attempts: number | null;
  quarantine: { reason: string; detail: string | null }[];
  replayed: boolean;
  attempt_status: string | null;
  attempt_detail: string | null;
  awaiting_approval: boolean;
}

// SQL over `e` (an events row) that mirrors eventStatus, so a status filter can narrow the rows before
// the limit. The computed status in JS stays the final word.
const HAS_JOB = `EXISTS (SELECT 1 FROM queue j WHERE j.kind = 'ingest' AND j.event_id = e.id)`;
const openReason = (reasons: string) =>
  `EXISTS (SELECT 1 FROM quarantine r WHERE r.account_id = e.account_id AND r.event_id = e.id
     AND r.released_at IS NULL${reasons ? ` AND r.reason IN (${reasons})` : ''})`;
const HAS_OPEN = openReason('');
const HAS_UNKNOWN = openReason(`'unknown_fingerprint'`);
const GENERATING = `(${openReason([...GENERATOR_REASONS].map((r) => `'${r}'`).join(', '))} AND (
     SELECT t.status FROM adapter_attempts t
     WHERE t.account_id = e.account_id AND t.source = e.source AND t.op = e.op AND t.fingerprint = e.fingerprint
     ORDER BY t.started_at DESC LIMIT 1
   ) IS NOT DISTINCT FROM 'running')`;

const STATUS_SQL: Record<EventStatus, string> = {
  queued: HAS_JOB,
  written: `NOT ${HAS_JOB} AND NOT ${HAS_OPEN}`,
  adapter_generating: `NOT ${HAS_JOB} AND ${GENERATING}`,
  waiting: `NOT ${HAS_JOB} AND NOT ${GENERATING} AND ${HAS_UNKNOWN}`,
  quarantined: `NOT ${HAS_JOB} AND ${HAS_OPEN} AND NOT ${GENERATING} AND NOT ${HAS_UNKNOWN}`,
};

interface ReadFilter {
  accountId: string;
  limit: number;
  source?: string;
  status?: EventStatus;
  eventId?: string;
}

/**
 * One statement, so one snapshot. An event and its job commit together (§5.1), and a job is deleted in
 * the same transaction that quarantines it (§5.2), so no event can be seen between those states.
 * `adapter_attempts` is matched on the event's own fingerprint.
 */
async function readEvents(db: Queryable, filter: ReadFilter): Promise<EventView[]> {
  const params: unknown[] = [filter.accountId, filter.limit, MAX_DETAIL_LENGTH];
  const where = ['e.account_id = $1'];
  if (filter.source !== undefined) {
    params.push(filter.source);
    where.push(`e.source = $${params.length}`);
  }
  if (filter.eventId !== undefined) {
    params.push(filter.eventId);
    where.push(`e.id = $${params.length}`);
  }
  if (filter.status !== undefined) where.push(`(${STATUS_SQL[filter.status]})`);

  const { rows } = await db.query<EventRow>(
    `SELECT e.id, e.seq::text AS seq, e.source, e.op, e.fingerprint, e.received_at,
       j.attempts,
       COALESCE(q.open, '[]') AS quarantine,
       COALESCE(q.replayed, false) AS replayed,
       a.status AS attempt_status, left(a.detail, $3) AS attempt_detail,
       EXISTS (
         SELECT 1 FROM adapters ad
         WHERE ad.account_id = e.account_id AND ad.source = e.source AND ad.op = e.op
           AND ad.validated_at IS NOT NULL AND NOT ad.active AND ad.superseded_at IS NULL
           AND (ad.fingerprint = e.fingerprint OR EXISTS (
             SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = ad.id AND f.fingerprint = e.fingerprint))
       ) AS awaiting_approval
     FROM (
       SELECT e.id, e.seq, e.account_id, e.source, e.op, e.fingerprint, e.received_at
       FROM events e
       WHERE ${where.join(' AND ')}
       ORDER BY e.seq DESC
       LIMIT $2
     ) e
     LEFT JOIN queue j ON j.kind = 'ingest' AND j.event_id = e.id
     LEFT JOIN LATERAL (
       SELECT
         jsonb_agg(jsonb_build_object('reason', r.reason, 'detail', left(r.detail, $3)) ORDER BY r.quarantined_at)
           FILTER (WHERE r.released_at IS NULL) AS open,
         bool_or(r.released_by_adapter_id IS NOT NULL) AS replayed
       FROM quarantine r
       WHERE r.account_id = e.account_id AND r.event_id = e.id
     ) q ON true
     LEFT JOIN LATERAL (
       SELECT t.status, t.detail FROM adapter_attempts t
       WHERE t.account_id = e.account_id AND t.source = e.source AND t.op = e.op AND t.fingerprint = e.fingerprint
       ORDER BY t.started_at DESC
       LIMIT 1
     ) a ON true
     ORDER BY e.seq DESC`,
    params,
  );

  const events = rows.map(
    (row): EventView => ({
      id: row.id,
      seq: row.seq,
      source: row.source,
      op: row.op,
      fingerprint: row.fingerprint,
      receivedAt: row.received_at.toISOString(),
      status: eventStatus(row),
      attempts: row.attempts,
      quarantine: row.quarantine,
      adapterFailure: row.attempt_status === 'failed' ? row.attempt_detail : null,
      replayed: row.replayed && row.quarantine.length === 0,
      awaitingApproval: row.awaiting_approval,
    }),
  );
  return filter.status === undefined ? events : events.filter((event) => event.status === filter.status);
}

/** The account's most recent events, newest first. */
export function listRecentEvents(
  db: Queryable,
  opts: { accountId: string; limit?: number; source?: string; status?: EventStatus },
): Promise<EventView[]> {
  const requested = Math.floor(opts.limit ?? DEFAULT_EVENT_LIMIT);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_EVENT_LIMIT) : DEFAULT_EVENT_LIMIT;
  if (opts.status !== undefined && !EVENT_STATUSES.includes(opts.status)) return Promise.resolve([]);
  return readEvents(db, { accountId: opts.accountId, limit, source: opts.source, status: opts.status });
}

/** One event, or null when it doesn't exist, belongs to another account, or `eventId` isn't a UUID. */
export async function getEvent(db: Queryable, accountId: string, eventId: string): Promise<EventView | null> {
  if (!isUuid(eventId)) return null;
  const [event] = await readEvents(db, { accountId, limit: 1, eventId });
  return event ?? null;
}

/** Every distinct `events.source` the account has sent, '' (no path) included, sorted. */
export async function listSources(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ source: string }>(
    'SELECT DISTINCT source FROM events WHERE account_id = $1 ORDER BY source',
    [accountId],
  );
  return rows.map((row) => row.source);
}

export async function getPipelineSummary(db: Queryable, accountId: string): Promise<PipelineSummary> {
  const [reasons, waiting, shapes, running, failure, approval] = await Promise.all([
    db.query<{ reason: string; n: number }>(
      `SELECT reason, count(*)::int AS n FROM quarantine
        WHERE account_id = $1 AND released_at IS NULL
        GROUP BY reason ORDER BY n DESC, reason`,
      [accountId],
    ),
    db.query<{ events: number; shapes: number }>(
      `SELECT count(DISTINCT e.id)::int AS events,
              count(DISTINCT (e.source, e.op, e.fingerprint))::int AS shapes
         FROM quarantine q JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
        WHERE q.account_id = $1 AND q.released_at IS NULL AND q.reason = 'unknown_fingerprint'`,
      [accountId],
    ),
    db.query<{ source: string; op: string; fingerprint: string; events: number; oldest: Date }>(
      `SELECT e.source, e.op, e.fingerprint, count(DISTINCT e.id)::int AS events, min(q.quarantined_at) AS oldest
         FROM quarantine q JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
        WHERE q.account_id = $1 AND q.released_at IS NULL AND q.reason = 'unknown_fingerprint'
          AND e.fingerprint IS NOT NULL
        GROUP BY e.source, e.op, e.fingerprint
        ORDER BY events DESC, oldest
        LIMIT ${WAITING_SHAPES_SHOWN}`,
      [accountId],
    ),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM adapter_attempts WHERE account_id = $1 AND status = 'running'`,
      [accountId],
    ),
    db.query<{ source: string; op: string; detail: string | null; finished_at: Date }>(
      `SELECT source, op, left(detail, $2) AS detail, finished_at FROM adapter_attempts
        WHERE account_id = $1 AND status = 'failed'
          AND finished_at > now() - make_interval(hours => ${FAILURE_WINDOW_HOURS})
        ORDER BY finished_at DESC LIMIT 1`,
      [accountId, MAX_DETAIL_LENGTH],
    ),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM adapters
        WHERE account_id = $1 AND validated_at IS NOT NULL AND active = false AND superseded_at IS NULL`,
      [accountId],
    ),
  ]);
  const last = failure.rows[0];
  return {
    quarantineByReason: reasons.rows.map((r) => ({ reason: r.reason, count: r.n })),
    waitingEvents: waiting.rows[0]?.events ?? 0,
    waitingShapeCount: waiting.rows[0]?.shapes ?? 0,
    waitingShapes: shapes.rows.map((r) => ({
      source: r.source,
      op: r.op,
      fingerprint: r.fingerprint,
      events: r.events,
      oldestQuarantinedAt: r.oldest.toISOString(),
    })),
    generationsRunning: running.rows[0]?.n ?? 0,
    lastFailure: last
      ? { source: last.source, op: last.op, detail: last.detail, finishedAt: last.finished_at.toISOString() }
      : null,
    awaitingApproval: approval.rows[0]?.n ?? 0,
  };
}

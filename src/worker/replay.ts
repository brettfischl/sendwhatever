// A `replay` job, and the sweep that enqueues one for stranded rows (PRD §5.2 steps 8 onward, §15).
//
// The job's only progress is in `quarantine`: a released row isn't selected again, so a retry or a repeat
// after a crash carries on from there. A worker that dies between a write and the release repeats that
// write, which leaves the same rows (§11.2).
//
// `replay_log.status` is `released`, `failed`, or `store_failed`. Only `failed` says the adapter failed,
// which is what the generator's cap counts (§12.1). `store_failed` is one store's problem.
import type { JobDecision, JobHandler } from './ingest.js';
import { findAdapter, type MatchedAdapter } from './match.js';
import {
  adaptEvent,
  errorMessage,
  loadEvent,
  loadLiveStores,
  writeToStores,
  type LoggedEvent,
  type StoreWrites,
  type WorkerContext,
} from './pipeline.js';
import { pushRunAt, toDetail, type Job, type QuarantineEntry } from './queue.js';

interface OpenRow {
  id: string;
  eventId: string;
  /** The store the row names, or `null` for all live stores. */
  storeId: string | null;
  fingerprint: string;
  /** Decimal text. */
  seq: string;
}

interface Cursor {
  seq: string;
  id: string;
}

const START: Cursor = { seq: '0', id: '00000000-0000-0000-0000-000000000000' };

/**
 * The next open rows this adapter might match, oldest event first. An inactive adapter matches none, so
 * a superseded version's replay ends at its next page and leaves the rest to the new version's.
 *
 * An opaque adapter can't be matched in SQL, since that needs the body, so its pages hold every open row
 * of the source and op, and `replayPage` narrows them down.
 */
async function loadPage(context: WorkerContext, job: Job, adapterId: string, after: Cursor): Promise<OpenRow[]> {
  const result = await context.db.query<OpenRow>(
    `SELECT q.id, q.event_id AS "eventId", q.store_id AS "storeId", e.fingerprint, e.seq::text AS seq
     FROM adapters a
     JOIN events e ON e.account_id = a.account_id AND e.source = a.source AND e.op = a.op
     JOIN quarantine q ON q.account_id = e.account_id AND q.event_id = e.id
     WHERE a.id = $1 AND a.account_id = $2 AND a.active
       AND q.released_at IS NULL AND q.reason <> 'malformed' AND e.fingerprint IS NOT NULL
       AND (
         cardinality(a.opaque_paths) > 0
         OR e.fingerprint = a.fingerprint
         OR EXISTS (SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = e.fingerprint)
       )
       AND (e.seq, q.id) > ($3::bigint, $4::uuid)
     ORDER BY e.seq, q.id
     LIMIT $5`,
    [adapterId, job.accountId, after.seq, after.id, context.settings.replayBatchSize],
  );
  return result.rows;
}

interface RowWrites extends StoreWrites {
  /** At least one store took the write. */
  wrote: boolean;
}

/** Writes one row's event to the stores it applies to. Anything thrown means the platform failed. */
async function writeRow(
  context: WorkerContext,
  job: Job,
  row: OpenRow,
  event: LoggedEvent,
  adapter: MatchedAdapter,
): Promise<RowWrites> {
  const failure = (entry: Omit<QuarantineEntry, 'storeId'>): RowWrites => ({
    permanent: [{ storeId: row.storeId, ...entry }],
    transient: [],
    wrote: false,
  });

  const adapted = await adaptEvent(context, event, adapter);
  if (!adapted.ok) return failure({ reason: adapted.reason, detail: adapted.detail });

  const live = await loadLiveStores(context.db, job.accountId);
  const targets = row.storeId === null ? live : live.filter(({ id }) => id === row.storeId);
  if (targets.length === 0) {
    if (row.storeId === null) throw new Error(`Account ${job.accountId} has no live store`);
    // Activating a store closes the rows naming the old one (§5.4), so this should be rare. Writing there
    // isn't allowed, and failing the row leaves it to an operator without the sweep picking it up again.
    return failure({ reason: 'write_error', detail: `Store ${row.storeId} is no longer live` });
  }
  const writes = await writeToStores(context, targets, adapted.plan);
  return { ...writes, wrote: writes.permanent.length + writes.transient.length < targets.length };
}

/** A single statement, so the release and its log entry are one transaction. A row already released stays so. */
async function releaseRow(context: WorkerContext, row: OpenRow, adapterId: string): Promise<void> {
  await context.db.query(
    `WITH released AS (
       UPDATE quarantine SET released_at = now(), released_by_adapter_id = $2
       WHERE id = $1 AND released_at IS NULL
       RETURNING id, account_id
     )
     INSERT INTO replay_log (account_id, quarantine_id, adapter_id, status)
     SELECT account_id, id, $2, 'released' FROM released`,
    [row.id, adapterId],
  );
}

/**
 * Some stores took the write and others failed for good, so what's left to do is theirs alone. Releases
 * the row and opens one naming each failed store, as ingest would have recorded them. A single statement,
 * so a row already released opens nothing, and `quarantine_one_open` keeps a repeat to one row per store.
 */
async function narrowRow(
  context: WorkerContext,
  row: OpenRow,
  adapterId: string,
  entries: readonly QuarantineEntry[],
): Promise<string[]> {
  const result = await context.db.query<{ quarantine_id: string }>(
    `WITH released AS (
       UPDATE quarantine SET released_at = now(), released_by_adapter_id = $2
       WHERE id = $1 AND released_at IS NULL
       RETURNING id, account_id, event_id
     ), narrowed AS (
       INSERT INTO quarantine (event_id, account_id, store_id, reason, detail)
       SELECT r.event_id, r.account_id, f.store_id, f.reason, f.detail
       FROM released r
       CROSS JOIN unnest($3::uuid[], $4::text[], $5::text[]) AS f(store_id, reason, detail)
       ON CONFLICT (event_id, store_id) WHERE released_at IS NULL
       DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
       RETURNING id, account_id, reason, detail
     )
     INSERT INTO replay_log (account_id, quarantine_id, adapter_id, status, detail)
     SELECT account_id, id, $2::uuid, 'released', NULL FROM released
     UNION ALL
     SELECT account_id, id, $2::uuid, 'store_failed', reason || ': ' || detail FROM narrowed
     RETURNING quarantine_id`,
    [
      row.id,
      adapterId,
      entries.map(({ storeId }) => storeId),
      entries.map(({ reason }) => reason),
      entries.map(({ detail }) => toDetail(detail)),
    ],
  );
  return result.rows.map(({ quarantine_id: id }) => id);
}

/** The row stays open with its new reason, which is what stops the sweep from retrying it (§5.2). */
async function failRow(
  context: WorkerContext,
  row: OpenRow,
  adapterId: string,
  entries: readonly QuarantineEntry[],
  status: 'failed' | 'store_failed',
): Promise<void> {
  const detail = toDetail(
    entries
      .map((entry) => (row.storeId === null && entry.storeId ? `Store ${entry.storeId}: ${entry.detail}` : entry.detail))
      .join('; '),
  );
  await context.db.query(
    `WITH failed AS (
       UPDATE quarantine SET reason = $3, detail = $4
       WHERE id = $1 AND released_at IS NULL
       RETURNING id, account_id
     )
     INSERT INTO replay_log (account_id, quarantine_id, adapter_id, status, detail)
     SELECT account_id, id, $2, $5, $3 || ': ' || $4 FROM failed`,
    [row.id, adapterId, entries[0]!.reason, detail, status],
  );
}

/** What one attempt at the job has done so far. */
interface ReplayPass {
  released: number;
  failed: number;
  /** Rows just opened by `narrowRow`. One can sort after the row it came from, and has only just failed. */
  narrowed: Set<string>;
}

/** Returns the transient failure that should stop this attempt, if there is one. */
async function replayRow(
  context: WorkerContext,
  job: Job,
  row: OpenRow,
  adapterId: string,
  notOurs: Set<string>,
  pass: ReplayPass,
): Promise<string | undefined> {
  if (pass.narrowed.has(row.id)) return undefined;

  // Equal full fingerprints collapse to equal shapes, so one lookup rules out every row with this one.
  if (notOurs.has(row.fingerprint)) return undefined;

  // A failure in these two says nothing about this row, which may not even be this adapter's. So they
  // can't count against it at the maximum age, and handleReplay backs off instead.
  const event = await loadEvent(context.db, job.accountId, row.eventId);
  // Looked up for each row we write, so a superseded version stops at once rather than at the next page.
  const adapter = await findAdapter(context.db, event);
  if (adapter?.id !== adapterId) {
    // Another adapter handles this event (§7.1), and that adapter's own replay or the sweep will reach it.
    notOurs.add(row.fingerprint);
    return undefined;
  }

  const expired = job.ageMs >= context.settings.maxAgeMs;
  let writes: RowWrites;
  try {
    writes = await writeRow(context, job, row, event, adapter);
  } catch (error) {
    writes = { permanent: [], transient: [{ storeId: row.storeId, detail: errorMessage(error) }], wrote: false };
  }

  if (writes.transient.length > 0 && !expired) {
    // Recorded now, like ingest, rather than hidden for as long as the other store is down. The row
    // can't narrow yet, as the retry settles which stores still need it.
    if (writes.permanent.length > 0) {
      await failRow(context, row, adapterId, writes.permanent, 'store_failed');
      pass.failed += 1;
    }
    return writes.transient.map(({ detail }) => detail).join('; ');
  }

  const entries: QuarantineEntry[] = [
    ...writes.permanent,
    ...writes.transient.map(({ storeId, detail }) => ({
      storeId,
      reason: 'write_error' as const,
      detail: `Still failing at the maximum age: ${detail}`,
    })),
  ];
  if (entries.length > 0 && row.storeId === null && writes.wrote) {
    for (const id of await narrowRow(context, row, adapterId, entries)) pass.narrowed.add(id);
    pass.released += 1;
    pass.failed += entries.length;
  } else if (entries.length > 0) {
    // On a row naming a store, only an adapter error is the adapter's fault.
    const storeOnly = row.storeId !== null && entries[0]!.reason !== 'adapter_error';
    await failRow(context, row, adapterId, entries, storeOnly ? 'store_failed' : 'failed');
    pass.failed += 1;
  } else {
    await releaseRow(context, row, adapterId);
    pass.released += 1;
  }
  return undefined;
}

/** Runs one row at a time, so this job never has more than one adapter running. */
async function replayPages(context: WorkerContext, job: Job, adapterId: string): Promise<JobDecision> {
  const pass: ReplayPass = { released: 0, failed: 0, narrowed: new Set() };
  let after = START;
  for (;;) {
    const page = await loadPage(context, job, adapterId, after);
    if (page.length === 0) break;

    // The heartbeat keeps the lease while this job runs, but only this tells it that the lease has gone.
    if (!(await pushRunAt(context.db, job, context.settings.leaseMs))) return { kind: 'lease_lost' };

    // Fresh for each page, so a row isn't passed over for long if the adapters change.
    const notOurs = new Set<string>();
    for (const row of page) {
      const transient = await replayRow(context, job, row, adapterId, notOurs, pass);
      if (transient !== undefined) return { kind: 'backoff', detail: transient };
    }
    const last = page[page.length - 1]!;
    after = { seq: last.seq, id: last.id };
  }
  context.settings.log(`Replay job ${job.id}: released ${pass.released} rows, ${pass.failed} failed`);
  return { kind: 'finish_replay' };
}

export const handleReplay: JobHandler = async (context, job) => {
  const adapterId = job.adapterId;
  if (adapterId === null) throw new Error(`Replay job ${job.id} has no adapter`);
  try {
    return await replayPages(context, job, adapterId);
  } catch (error) {
    // Only the application database failing gets here, as a row's own failures are recorded on it.
    return { kind: 'backoff', detail: errorMessage(error) };
  }
};

/**
 * Enqueues a replay for each active adapter with a matching `unknown_fingerprint` row and no replay
 * queued, and returns the IDs of those it enqueued. A worker can look up an adapter just before
 * activation and quarantine just after the replay finishes (§5.2).
 *
 * Unlike `enqueueReplay`, this leaves a queued replay alone. Rows it hasn't reached yet look just like
 * stranded ones, so asking it to rerun would repeat every long replay. A row it did miss is still here
 * at the next sweep, once the job has gone.
 *
 * Replaying a row either releases it or changes its reason, so a shape that keeps failing leaves this
 * query after one replay. Only one event per shape is checked, since equal full fingerprints collapse
 * to equal shapes.
 */
export async function sweepStrandedRows(
  context: WorkerContext,
  options: { accountId?: string | undefined } = {},
): Promise<string[]> {
  const { db } = context;
  const shapes = await db.query<{ accountId: string; eventId: string }>(
    `SELECT DISTINCT ON (q.account_id, e.source, e.op, e.fingerprint)
       q.account_id AS "accountId", e.id AS "eventId"
     FROM quarantine q
     JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
     WHERE q.released_at IS NULL AND q.reason = 'unknown_fingerprint' AND e.fingerprint IS NOT NULL
       AND ($1::uuid IS NULL OR q.account_id = $1::uuid)
       AND EXISTS (
         SELECT 1 FROM adapters a
         WHERE a.account_id = e.account_id AND a.source = e.source AND a.op = e.op AND a.active
       )
     ORDER BY q.account_id, e.source, e.op, e.fingerprint`,
    [options.accountId ?? null],
  );

  const adapterIds = new Set<string>();
  for (const { accountId, eventId } of shapes.rows) {
    const adapter = await findAdapter(db, await loadEvent(db, accountId, eventId));
    if (adapter) adapterIds.add(adapter.id);
  }
  const enqueued = await db.query<{ adapter_id: string }>(
    `INSERT INTO queue (account_id, kind, adapter_id)
     SELECT account_id, 'replay', id FROM adapters WHERE id = ANY($1::uuid[]) AND active
     ON CONFLICT (adapter_id) WHERE kind = 'replay' DO NOTHING
     RETURNING adapter_id`,
    [[...adapterIds]],
  );
  return enqueued.rows.map((row) => row.adapter_id);
}

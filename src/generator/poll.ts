// Which shapes need work, and claiming one (PRD §12.1 step 1). A claim is a `running` row in
// `adapter_attempts`, under the event's own fingerprint, which is what the demo's tables panel reads.
import type pg from 'pg';
import type { GeneratorSettings } from './settings.js';

export interface Shape {
  accountId: string;
  source: string;
  op: 'write' | 'delete';
  /** The events' full fingerprint. */
  fingerprint: string;
}

export interface Claim extends Shape {
  attemptId: string;
  autoActivate: boolean;
  /** Some open row is `adapter_error` or `schema_conflict`, so whatever handles this shape now failed. */
  hasFailure: boolean;
}

export type AttemptOutcome = { status: 'succeeded' | 'failed'; adapterId?: string; detail: string };

type ShapeRow = { source: string; op: 'write' | 'delete'; fingerprint: string; has_failure: boolean; auto_activate: boolean };

/** How an attempt's `detail` starts when the LLM answered but its adapter never passed. */
export const GAVE_UP = 'Gave up after';
/** The attempt's `detail` when a shape matched an adapter, on an account that reviews what goes live. */
export const REUSE_NEEDS_OPERATOR = 'An existing adapter fits, but with auto_activate off it needs an operator.';
const TIMED_OUT = 'Timed out';

/**
 * Open shapes that are ready for work. Takes an account (or null for all) as $1, then $2 to $5 from
 * `eligibleParams`. A shape is left out if:
 * - its rows name a store. Those are one store's failures, which a new adapter can't fix.
 * - its source and op have a generation running. A shape's variations often arrive together, and going one
 *   at a time lets the first one's adapter absorb the rest through step 2, or its schema guide them.
 * - a validated adapter awaits an operator. An adapter left behind by this process's own failed attempt
 *   on an auto-activating account isn't waiting for anyone, so `runAttempt` finishes activating it.
 * - a replay that could reach it is queued. It may release these rows, or finish failing them.
 * - only `unknown_fingerprint` rows are open and an active adapter matches exactly. The sweep has those.
 * - with auto_activate off, it matched an adapter that's still active, which is an operator's call.
 * - it failed too many attempts in a row. Only one that spent model calls or timed out counts, so an outage
 *   can't park it, and a new event doesn't reset this.
 * - it reached the cap, or its last failure's backoff is still running. The cap counts failures on rows
 *   still open, so a shape that was fixed starts over if it fails again later.
 *
 * Adapter matching on opaque paths needs the body, so that part is left to `runAttempt`.
 */
const ELIGIBLE_SHAPES = `
  WITH open_shapes AS (
    SELECT q.account_id, e.source, e.op, e.fingerprint, MIN(e.seq) AS oldest_seq,
           bool_or(q.reason <> 'unknown_fingerprint') AS has_failure,
           acct.auto_activate
    FROM quarantine q
    JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
    JOIN accounts acct ON acct.id = q.account_id
    WHERE q.released_at IS NULL AND q.store_id IS NULL
      AND q.reason IN ('unknown_fingerprint', 'adapter_error', 'schema_conflict')
      AND e.fingerprint IS NOT NULL AND acct.status = 'active'
      AND ($1::uuid IS NULL OR q.account_id = $1::uuid)
    GROUP BY q.account_id, e.source, e.op, e.fingerprint, acct.auto_activate
  )
  SELECT s.* FROM open_shapes s
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS failures, MAX(t.finished_at) AS last_finished,
      count(*) FILTER (WHERE t.detail LIKE '${GAVE_UP}%' OR t.detail LIKE '${TIMED_OUT}%')::int AS counted
    FROM adapter_attempts t
    WHERE t.account_id = s.account_id AND t.source = s.source AND t.op = s.op AND t.fingerprint = s.fingerprint
      AND t.status = 'failed'
      AND t.started_at > COALESCE((
        SELECT MAX(ok.started_at) FROM adapter_attempts ok
        WHERE ok.account_id = s.account_id AND ok.source = s.source AND ok.op = s.op
          AND ok.fingerprint = s.fingerprint AND ok.status = 'succeeded'
      ), '-infinity'::timestamptz)
  ) recent ON true
  WHERE NOT EXISTS (
      SELECT 1 FROM adapter_attempts t
      WHERE t.account_id = s.account_id AND t.source = s.source AND t.op = s.op AND t.status = 'running'
    )
    AND NOT EXISTS (
      SELECT 1 FROM adapters a
      WHERE a.account_id = s.account_id AND a.source = s.source AND a.op = s.op
        AND a.validated_at IS NOT NULL AND NOT a.active AND a.superseded_at IS NULL
        AND (a.fingerprint = s.fingerprint OR EXISTS (
          SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = s.fingerprint))
        AND NOT (s.auto_activate AND EXISTS (
          SELECT 1 FROM adapter_attempts t WHERE t.adapter_id = a.id AND t.status = 'failed'))
    )
    AND NOT EXISTS (
      SELECT 1 FROM queue j
      JOIN adapters a ON a.id = j.adapter_id
      WHERE j.kind = 'replay' AND a.account_id = s.account_id AND a.source = s.source AND a.op = s.op AND a.active
        AND (a.fingerprint = s.fingerprint OR cardinality(a.opaque_paths) > 0 OR EXISTS (
          SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = s.fingerprint))
    )
    AND (s.has_failure OR NOT EXISTS (
      SELECT 1 FROM adapters a
      WHERE a.account_id = s.account_id AND a.source = s.source AND a.op = s.op AND a.active
        AND (a.fingerprint = s.fingerprint OR EXISTS (
          SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = s.fingerprint))
    ))
    AND (
      SELECT count(DISTINCT l.adapter_id)
      FROM replay_log l
      JOIN quarantine r ON r.account_id = l.account_id AND r.id = l.quarantine_id
      JOIN events re ON re.account_id = r.account_id AND re.id = r.event_id
      WHERE l.account_id = s.account_id AND l.status = 'failed' AND r.released_at IS NULL
        AND re.source = s.source AND re.op = s.op AND re.fingerprint = s.fingerprint
    ) < $2::int
    AND recent.counted < $5::int
    AND NOT (NOT s.auto_activate AND EXISTS (
      SELECT 1 FROM adapter_attempts t
      JOIN adapters a ON a.id = t.adapter_id AND a.active
      WHERE t.account_id = s.account_id AND t.source = s.source AND t.op = s.op AND t.fingerprint = s.fingerprint
        AND t.status = 'succeeded' AND t.detail = '${REUSE_NEEDS_OPERATOR}'
    ))
    AND (
      recent.failures = 0 OR recent.last_finished +
        LEAST($4::double precision, $3::double precision * 2 ^ LEAST(recent.failures - 1, 30))
        * interval '1 millisecond' <= now()
    )`;

function eligibleParams(settings: GeneratorSettings): [number, number, number, number] {
  return [settings.generationCap, settings.attemptBackoffBaseMs, settings.attemptBackoffMaxMs, settings.maxFailedAttempts];
}

export async function inTransaction<T>(db: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  // The pool only listens to idle clients, so losing the connection here would otherwise be an unhandled
  // 'error' event that crashes the process. The next query rejects instead.
  const onError = (error: Error) => {
    broken = error;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Destroy the connection rather than return one with an open transaction to the pool.
    await client.query('ROLLBACK').catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}

/**
 * Claims the account's oldest eligible shape, if it's under its concurrency cap. The advisory lock makes
 * the count and the insert one step across processes, and is only held for this short transaction.
 * Attempts left running past the timeout are failed first, or they'd block their shapes and use up the
 * cap, and it happens here because the insert would otherwise hit `adapter_attempts_one_running`.
 */
async function claimForAccount(db: pg.Pool, accountId: string, settings: GeneratorSettings): Promise<Claim | null> {
  return inTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sw_generator:${accountId}`]);
    await client.query(
      `UPDATE adapter_attempts
       SET status = 'failed', finished_at = now(), detail = '${TIMED_OUT}: no result after the attempt limit.'
       WHERE account_id = $1 AND status = 'running'
         AND started_at < now() - $2::double precision * interval '1 millisecond'`,
      [accountId, settings.staleAttemptMs],
    );
    const running = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM adapter_attempts WHERE account_id = $1 AND status = 'running'`,
      [accountId],
    );
    if (running.rows[0]!.count >= settings.accountConcurrency) return null;

    const shapes = await client.query<ShapeRow>(`${ELIGIBLE_SHAPES} ORDER BY s.oldest_seq LIMIT 1`, [
      accountId,
      ...eligibleParams(settings),
    ]);
    const shape = shapes.rows[0];
    if (!shape) return null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [accountId, shape.source, shape.op, shape.fingerprint],
    );
    return {
      attemptId: inserted.rows[0]!.id,
      accountId,
      source: shape.source,
      op: shape.op,
      fingerprint: shape.fingerprint,
      autoActivate: shape.auto_activate,
      hasFailure: shape.has_failure,
    };
  });
}

/**
 * Claims the next shape, trying the account that started an attempt longest ago first, so one busy
 * account can't starve the others. Accounts with a stale attempt are included so it gets cleared even if
 * nothing else on that account is ready.
 */
export async function claimNext(db: pg.Pool, settings: GeneratorSettings): Promise<Claim | null> {
  const accounts = await db.query<{ account_id: string }>(
    `WITH candidates AS (
       SELECT account_id FROM (${ELIGIBLE_SHAPES}) eligible
       UNION
       SELECT account_id FROM adapter_attempts
       WHERE status = 'running' AND started_at < now() - $6::double precision * interval '1 millisecond'
         AND ($1::uuid IS NULL OR account_id = $1::uuid)
     )
     SELECT c.account_id FROM candidates c
     ORDER BY (SELECT MAX(t.started_at) FROM adapter_attempts t WHERE t.account_id = c.account_id) NULLS FIRST`,
    [settings.accountId ?? null, ...eligibleParams(settings), settings.staleAttemptMs],
  );
  for (const { account_id: accountId } of accounts.rows) {
    const claim = await claimForAccount(db, accountId, settings);
    if (claim) return claim;
  }
  return null;
}

/**
 * A timed-out attempt is already `failed`, and this leaves it so, as its shape may have a new attempt.
 * `detail` is shown in the demo and admin, so callers give only codes and counts, never payload values.
 */
export async function finishAttempt(db: pg.Pool, attemptId: string, outcome: AttemptOutcome): Promise<void> {
  await db.query(
    `UPDATE adapter_attempts SET status = $2, adapter_id = COALESCE($3, adapter_id), detail = $4, finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [attemptId, outcome.status, outcome.adapterId ?? null, outcome.detail],
  );
}

/** Records the adapter while the attempt runs, so a crash before activation can be picked up. */
export async function linkAttempt(db: pg.Pool, attemptId: string, adapterId: string): Promise<void> {
  await db.query(`UPDATE adapter_attempts SET adapter_id = $2 WHERE id = $1`, [attemptId, adapterId]);
}

/** False means the attempt timed out, and another may already be running, so this one must stop. */
export async function stillRunning(db: pg.Pool, attemptId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM adapter_attempts WHERE id = $1 AND status = 'running'`, [attemptId]);
  return result.rowCount === 1;
}

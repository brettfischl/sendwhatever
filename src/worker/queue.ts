// The queue (PRD §10.1). `run_at` is the next eligible time, so it doubles as the lease and the backoff.
//
// `attempts` is also a fencing token. Every claim changes it, so a worker that stalled past its lease
// finds its statements match nothing and can't delete or reschedule a job another worker now holds.
import type pg from 'pg';

export type JobKind = 'ingest' | 'replay' | 'rebuild';

export type QuarantineReason = 'unknown_fingerprint' | 'adapter_error' | 'schema_conflict' | 'write_error';

export interface QuarantineEntry {
  /** The store the failure applies to, or `null` for all live stores. */
  storeId: string | null;
  reason: QuarantineReason;
  detail: string;
}

export interface Job {
  id: string;
  accountId: string;
  kind: JobKind;
  eventId: string | null;
  adapterId: string | null;
  storeId: string | null;
  /** Includes this claim. */
  attempts: number;
  /** Time since the job was created, by the database's clock. */
  ageMs: number;
}

export interface ClaimOptions {
  kinds: readonly JobKind[];
  leaseMs: number;
  /** Only claim this account's jobs. */
  accountId?: string | undefined;
}

const MAX_DETAIL_LENGTH = 2000;

/** `detail` can quote adapter errors, and Postgres `TEXT` rejects a NUL byte. */
export function toDetail(text: string): string {
  return text.replaceAll('\u0000', '�').slice(0, MAX_DETAIL_LENGTH);
}

export async function claimJob(db: pg.Pool, options: ClaimOptions): Promise<Job | null> {
  const result = await db.query<{
    id: string;
    account_id: string;
    kind: JobKind;
    event_id: string | null;
    adapter_id: string | null;
    store_id: string | null;
    attempts: number;
    age_ms: number;
  }>(
    `UPDATE queue
     SET run_at = now() + $1::double precision * interval '1 millisecond', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM queue
       WHERE run_at <= now() AND kind = ANY($2::text[]) AND ($3::uuid IS NULL OR account_id = $3::uuid)
       ORDER BY run_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, account_id, kind, event_id, adapter_id, store_id, attempts,
       (extract(epoch FROM now() - created_at) * 1000)::double precision AS age_ms`,
    [options.leaseMs, options.kinds, options.accountId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    eventId: row.event_id,
    adapterId: row.adapter_id,
    storeId: row.store_id,
    attempts: row.attempts,
    ageMs: row.age_ms,
  };
}

/** Pushes `run_at` forward, by a lease or a backoff. False means another worker now holds the job. */
export async function pushRunAt(db: pg.Pool, job: Job, delayMs: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE queue SET run_at = now() + $3::double precision * interval '1 millisecond'
     WHERE id = $1 AND attempts = $2`,
    [job.id, job.attempts, delayMs],
  );
  return result.rowCount === 1;
}

/** False means another worker now holds the job. */
export async function deleteJob(db: pg.Pool, job: Job): Promise<boolean> {
  const result = await db.query('DELETE FROM queue WHERE id = $1 AND attempts = $2', [job.id, job.attempts]);
  return result.rowCount === 1;
}

/**
 * Records an ingest job's failures and, in one transaction, deletes the job, or reschedules it if
 * `retryInMs` is set because another store is still retrying. Rows use the job's account, and the job's
 * account matches its event's through the foreign key. False means another worker now holds the job,
 * and nothing changed.
 */
export async function quarantineJob(
  db: pg.Pool,
  job: Job,
  eventId: string,
  entries: readonly QuarantineEntry[],
  { retryInMs }: { retryInMs?: number } = {},
): Promise<boolean> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const held =
      retryInMs === undefined
        ? await client.query('DELETE FROM queue WHERE id = $1 AND attempts = $2', [job.id, job.attempts])
        : await client.query(
            `UPDATE queue SET run_at = now() + $3::double precision * interval '1 millisecond'
             WHERE id = $1 AND attempts = $2`,
            [job.id, job.attempts, retryInMs],
          );
    if (held.rowCount !== 1) {
      await client.query('ROLLBACK');
      return false;
    }
    for (const { storeId, reason, detail } of entries) {
      await client.query(
        `INSERT INTO quarantine (event_id, account_id, store_id, reason, detail)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id, store_id) WHERE released_at IS NULL
         DO UPDATE SET reason = EXCLUDED.reason, detail = EXCLUDED.detail`,
        [eventId, job.accountId, storeId, reason, toDetail(detail)],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    // Destroy the connection rather than return one with an open transaction to the pool.
    await client.query('ROLLBACK').catch((rollbackError: Error) => {
      broken = rollbackError;
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

/** Capped exponential backoff. `attempts` counts from 1, which waits `baseMs`. */
export function backoffMs(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** (attempts - 1));
}

/**
 * Keeps renewing the lease while a job runs, including through a schema change that can take minutes
 * (§10.1). Awaiting the returned function waits for any renewal in flight, so it can't overwrite the
 * `run_at` that a backoff sets next. A failed renewal is only logged: the job carries on, and if the
 * lease does run out, the repeat is harmless because writes are idempotent.
 */
export function startHeartbeat(
  db: pg.Pool,
  job: Job,
  { leaseMs, log }: { leaseMs: number; log: (message: string) => void },
): () => Promise<void> {
  let renewal: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => pushRunAt(db, job, leaseMs))
      .catch((error: Error) => log(`Job ${job.id}: could not renew its lease: ${error.message}`));
    // Often enough that one slow or failed renewal doesn't lose the lease.
  }, leaseMs / 3);
  return async () => {
    clearInterval(timer);
    await renewal;
  };
}

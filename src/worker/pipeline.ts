// The steps from a logged event to rows in a store (PRD §5.1 steps 7-10). Ingest and replay both use
// them, so an event is processed the same way each time.
import type pg from 'pg';
import { StorageError, type AdapterRequest, type AdapterResult, type StorageBackend, type StoreConfig } from '../contracts/index.js';
import { applyPlanSchema, planWrite, type WritePlan } from '../planner/index.js';
import { runAdapter, type SandboxLimits } from '../sandbox/index.js';
import type { MatchedAdapter } from './match.js';
import type { QuarantineEntry } from './queue.js';

export interface WorkerSettings {
  /** How long a claim holds a job before another worker may take it. */
  leaseMs: number;
  /** The wait after a first transient failure, which then doubles. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long a job may keep hitting transient failures before it moves to `write_error` (§10.1). */
  maxAgeMs: number;
  /** Open quarantine rows a replay reads at a time. */
  replayBatchSize: number;
  /** How often to look for stranded `unknown_fingerprint` rows (§5.2). */
  sweepIntervalMs: number;
  sandboxLimits: SandboxLimits;
  log: (message: string) => void;
}

export const DEFAULT_SETTINGS: WorkerSettings = {
  leaseMs: 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  maxAgeMs: 72 * 60 * 60 * 1000,
  replayBatchSize: 100,
  sweepIntervalMs: 60_000,
  sandboxLimits: {},
  log: (message) => console.error(`[worker] ${message}`),
};

export interface WorkerContext {
  db: pg.Pool;
  /** Keyed by `account_stores.backend`. */
  backends: Readonly<Record<string, StorageBackend>>;
  /** Decrypts `account_stores.credentials`, using the platform's key (§11.4). */
  decryptCredentials: (encrypted: Buffer) => Record<string, unknown>;
  settings: WorkerSettings;
}

export interface LoggedEvent {
  id: string;
  accountId: string;
  /** Decimal text. */
  seq: string;
  /** The raw bytes decoded as UTF-8. */
  body: string;
  source: string;
  op: string;
  fingerprint: string | null;
  request: AdapterRequest;
  /**
   * ISO 8601 in UTC, with the database's full microseconds. It's formatted in SQL because a `Date`
   * would drop the microseconds, and it becomes `_deleted_at`, which replays have to reproduce.
   */
  receivedAt: string;
}

export async function loadEvent(db: pg.Pool, accountId: string, eventId: string): Promise<LoggedEvent> {
  const result = await db.query<Omit<LoggedEvent, 'body'> & { body: Buffer }>(
    `SELECT id, account_id AS "accountId", seq::text AS seq, body, source, op, fingerprint, request,
       to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "receivedAt"
     FROM events WHERE account_id = $1 AND id = $2`,
    [accountId, eventId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Event ${eventId} not found for account ${accountId}`);
  return { ...row, body: row.body.toString('utf8') };
}

export interface LiveStore {
  id: string;
  backend: string;
  status: string;
  connection: Record<string, unknown>;
  credentials: Buffer | null;
  namespace: string;
}

/**
 * The stores that take new events, active first (§5.1 step 10). A store still takes them while
 * `ready`, or it would be missing events by the time it's activated. Read for each job, so a new store
 * takes effect without a deployment (§11.4).
 */
export async function loadLiveStores(db: pg.Pool, accountId: string): Promise<LiveStore[]> {
  const result = await db.query<LiveStore>(
    `SELECT id, backend, status, connection, credentials, namespace FROM account_stores
     WHERE account_id = $1 AND status IN ('active', 'ready', 'building')
     ORDER BY status = 'active' DESC, generation`,
    [accountId],
  );
  return result.rows;
}

export type AdaptResult =
  | { ok: true; plan: WritePlan }
  | { ok: false; reason: 'adapter_error' | 'schema_conflict'; detail: string };

/** Runs the adapter and plans the write. Throws `SandboxUnavailableError` if the sandbox can't run. */
export async function adaptEvent(
  context: WorkerContext,
  event: LoggedEvent,
  adapter: MatchedAdapter,
): Promise<AdaptResult> {
  const result = await runAdapter(
    { code: adapter.code, body: event.body, request: event.request },
    context.settings.sandboxLimits,
  );
  if (!result.ok) return { ok: false, reason: 'adapter_error', detail: `${result.kind}: ${result.detail}` };
  // planWrite checks its input at runtime, since the output comes from untrusted code.
  return planWrite(result.output as AdapterResult, {
    eventId: event.id,
    eventSeq: event.seq,
    receivedAt: event.receivedAt,
    opaquePaths: adapter.opaquePaths,
  });
}

/** Keeps retrying. Reaching the maximum age turns it into `write_error` against `storeId`. */
export interface TransientFailure {
  storeId: string | null;
  detail: string;
}

export interface StoreWrites {
  /** Failures that retrying can't fix. Each names the store it applies to. */
  permanent: QuarantineEntry[];
  transient: TransientFailure[];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toStoreConfig(context: WorkerContext, store: LiveStore): StoreConfig {
  return {
    namespace: store.namespace,
    connection: store.connection,
    ...(store.credentials && { credentials: context.decryptCredentials(store.credentials) }),
  };
}

/**
 * Writes a plan to each store in order, one store's failure not holding back the others. A store that
 * already took this event takes it again harmlessly if the job repeats (§11.2).
 *
 * Any error other than a permanent `StorageError` is transient, including a backend or key this
 * worker doesn't have. Those are platform problems, which shouldn't quarantine every event (§10.1).
 */
export async function writeToStores(
  context: WorkerContext,
  stores: readonly LiveStore[],
  plan: WritePlan,
): Promise<StoreWrites> {
  const writes: StoreWrites = { permanent: [], transient: [] };
  for (const target of stores) {
    try {
      const backend = context.backends[target.backend];
      if (!backend) throw new Error(`This worker has no ${target.backend} backend`);
      const store = toStoreConfig(context, target);

      const schema = await applyPlanSchema(context.db, backend, { storeId: target.id, store }, plan);
      if (!schema.ok) {
        writes.permanent.push({ storeId: target.id, reason: schema.reason, detail: schema.detail });
        continue;
      }
      await backend.write(store, schema.tables);
    } catch (error) {
      const detail = errorMessage(error);
      if (error instanceof StorageError && !error.retryable) {
        writes.permanent.push({ storeId: target.id, reason: 'write_error', detail });
      } else {
        writes.transient.push({ storeId: target.id, detail });
      }
    }
  }
  return writes;
}

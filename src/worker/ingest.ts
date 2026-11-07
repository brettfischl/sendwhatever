// An `ingest` job (PRD §5.1 steps 5-11, §5.2 steps 1-3).
import { findAdapter } from './match.js';
import {
  adaptEvent,
  errorMessage,
  loadEvent,
  loadLiveStores,
  writeToStores,
  type StoreWrites,
  type WorkerContext,
} from './pipeline.js';
import type { Job, QuarantineEntry } from './queue.js';

/** What should happen to a job once its work has stopped. */
export type JobDecision =
  | { kind: 'delete' }
  /** `entries` are stores that have already failed for good, recorded now rather than at the end. */
  | { kind: 'retry'; detail: string; eventId: string; entries: QuarantineEntry[] }
  | { kind: 'quarantine'; eventId: string; entries: QuarantineEntry[] };

/**
 * How far past the maximum age a job with earlier attempts is given up on without another. A retrying
 * job normally settles within a backoff, so this mostly catches events that keep killing workers, with
 * room for a deploy or backlog to delay that last attempt.
 */
const GIVE_UP_GRACE_MS = 60 * 60 * 1000;

export type JobHandler = (context: WorkerContext, job: Job) => Promise<JobDecision>;

/**
 * Everything thrown here retries: a store's own failures are already sorted by `writeToStores`, and
 * what's left means the platform failed, such as `SandboxUnavailableError` or a lost application
 * database. Neither says anything about this event.
 */
async function attempt(context: WorkerContext, job: Job, eventId: string): Promise<StoreWrites> {
  const failure = (entry: Omit<QuarantineEntry, 'storeId'>): StoreWrites => ({
    // These come from the event and adapter, not a store, so they apply to all live stores.
    permanent: [{ storeId: null, ...entry }],
    transient: [],
  });

  const event = await loadEvent(context.db, job.accountId, eventId);
  const adapter = await findAdapter(context.db, event);
  if (!adapter) {
    return failure({
      reason: 'unknown_fingerprint',
      detail: `No active adapter for source ${JSON.stringify(event.source)}, op ${event.op}, fingerprint ${event.fingerprint}`,
    });
  }

  const adapted = await adaptEvent(context, event, adapter);
  if (!adapted.ok) return failure({ reason: adapted.reason, detail: adapted.detail });

  const stores = await loadLiveStores(context.db, job.accountId);
  if (stores.length === 0) throw new Error(`Account ${job.accountId} has no live store`);
  return writeToStores(context, stores, adapted.plan);
}

export const handleIngest: JobHandler = async (context, job) => {
  const eventId = job.eventId;
  if (eventId === null) throw new Error(`Ingest job ${job.id} has no event`);
  const { maxAgeMs, backoffMaxMs, leaseMs } = context.settings;
  const expired = job.ageMs >= maxAgeMs;

  if (job.attempts > 1 && job.ageMs >= maxAgeMs + backoffMaxMs + leaseMs + GIVE_UP_GRACE_MS) {
    return {
      kind: 'quarantine',
      eventId,
      entries: [
        {
          storeId: null,
          reason: 'write_error',
          detail: `Given up without another attempt: past the maximum age after ${job.attempts - 1} attempts. A worker may have died on this event.`,
        },
      ],
    };
  }

  let writes: StoreWrites;
  try {
    writes = await attempt(context, job, eventId);
  } catch (error) {
    writes = { permanent: [], transient: [{ storeId: null, detail: errorMessage(error) }] };
  }

  if (writes.transient.length > 0 && !expired) {
    return {
      kind: 'retry',
      detail: writes.transient.map(({ detail }) => detail).join('; '),
      eventId,
      entries: writes.permanent,
    };
  }

  const entries: QuarantineEntry[] = [
    ...writes.permanent,
    ...writes.transient.map(({ storeId, detail }) => ({
      storeId,
      reason: 'write_error' as const,
      detail: `Still failing at the maximum age: ${detail}`,
    })),
  ];
  return entries.length > 0 ? { kind: 'quarantine', eventId, entries } : { kind: 'delete' };
};

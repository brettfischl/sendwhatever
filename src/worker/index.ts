// The queue worker (PRD §10.1). Each slot claims one job at a time and each job runs at most one
// adapter at a time, so `concurrency` also caps the sandbox's child processes.
//
// No transaction stays open during adapter runs or backend writes. The claim commits before the job
// starts, and the only one held later is the schema registry's per-store lock (§9).
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { StorageBackend } from '../contracts/index.js';
import { PostgresBackend } from '../storage/postgres/index.js';
import { handleIngest, type JobHandler } from './ingest.js';
import { DEFAULT_SETTINGS, type WorkerContext, type WorkerSettings } from './pipeline.js';
import { handleReplay, sweepStrandedRows } from './replay.js';
import {
  backoffMs,
  claimJob,
  deleteJob,
  finishReplay,
  pushRunAt,
  quarantineJob,
  startHeartbeat,
  type Job,
  type JobKind,
} from './queue.js';

export { DEFAULT_SETTINGS } from './pipeline.js';
export type { WorkerContext, WorkerSettings } from './pipeline.js';
export { enqueueReplay } from './queue.js';
export { sweepStrandedRows } from './replay.js';

/** Rebuilds join here. A kind with no handler stays in the queue, unclaimed. */
const HANDLERS: Partial<Record<JobKind, JobHandler>> = { ingest: handleIngest, replay: handleReplay };
const HANDLED_KINDS = Object.keys(HANDLERS) as JobKind[];

/**
 * - `done`: the job is deleted, and its rows are written. A replay's failed rows stay in `quarantine`.
 * - `rerun`: a replay finished, and runs again because another was requested while it ran.
 * - `quarantined`: the job is deleted, with its failures in `quarantine`.
 * - `retry`: the job stays queued, with backoff.
 * - `lease_lost`: this worker stalled past its lease, and another now holds the job.
 */
export type JobOutcome = 'done' | 'rerun' | 'quarantined' | 'retry' | 'lease_lost';

export interface ProcessedJob {
  job: Job;
  outcome: JobOutcome;
}

/**
 * Claims and runs one job. Returns `null` if none is ready. Rejects only if the application database
 * can't record the result, and the job then runs again once its lease expires.
 */
export async function processNextJob(
  context: WorkerContext,
  options: { accountId?: string | undefined } = {},
): Promise<ProcessedJob | null> {
  const { settings, db } = context;
  const job = await claimJob(db, {
    kinds: HANDLED_KINDS,
    leaseMs: settings.leaseMs,
    accountId: options.accountId,
  });
  if (!job) return null;

  const handler = HANDLERS[job.kind];
  if (!handler) throw new Error(`No handler for ${job.kind} jobs`);

  const stopHeartbeat = startHeartbeat(db, job, {
    leaseMs: settings.leaseMs,
    log: settings.log,
  });
  let decision;
  try {
    decision = await handler(context, job);
  } finally {
    await stopHeartbeat();
  }

  let held: boolean;
  let outcome: JobOutcome;
  switch (decision.kind) {
    case 'delete':
      held = await deleteJob(db, job);
      outcome = 'done';
      break;
    case 'quarantine':
      held = await quarantineJob(db, job, decision.eventId, decision.entries);
      outcome = 'quarantined';
      break;
    case 'finish_replay': {
      const finished = await finishReplay(db, job);
      held = finished !== 'lease_lost';
      outcome = finished === 'rerun' ? 'rerun' : 'done';
      break;
    }
    case 'retry':
    case 'backoff': {
      const delay = backoffMs(job.attempts, settings.backoffBaseMs, settings.backoffMaxMs);
      settings.log(`Job ${job.id}: attempt ${job.attempts} failed, retrying in ${delay} ms: ${decision.detail}`);
      held =
        decision.kind === 'retry' && decision.entries.length > 0
          ? await quarantineJob(db, job, decision.eventId, decision.entries, { retryInMs: delay })
          : await pushRunAt(db, job, delay);
      outcome = 'retry';
      break;
    }
    case 'lease_lost':
      held = false;
      outcome = 'lease_lost';
      break;
  }
  return { job, outcome: held ? outcome : 'lease_lost' };
}

export interface WorkerOptions extends Partial<WorkerSettings> {
  /** The application database. */
  databaseUrl: string;
  decryptCredentials: WorkerContext['decryptCredentials'];
  /** Defaults to Postgres. Backends passed in here stay open when the worker stops. */
  backends?: Readonly<Record<string, StorageBackend>>;
  /** Jobs at once in this process, and so sandbox processes too. */
  concurrency?: number;
  /** How long to wait after finding no job. */
  pollMs?: number;
  /** Only claim this account's jobs. */
  accountId?: string;
}

export interface Worker {
  /** Stops claiming, lets running jobs finish, and closes connections. Safe to call twice. */
  stop(): Promise<void>;
}

export function startWorker(options: WorkerOptions): Worker {
  const { databaseUrl, decryptCredentials, backends, concurrency = 4, pollMs = 500, accountId, ...overrides } = options;
  const settings: WorkerSettings = { ...DEFAULT_SETTINGS, ...overrides };

  // A job can use two connections at once, one held for a schema lock and one for its heartbeat.
  const db = new pg.Pool({
    connectionString: databaseUrl,
    max: concurrency * 2 + 2,
    keepAlive: true,
    connectionTimeoutMillis: 10_000,
    // Longer than the registry's 30-second wait for a schema lock. The client's limit catches a dead
    // network, where the server's own timeout can't reach us.
    statement_timeout: 45_000,
    query_timeout: 50_000,
  });
  // Without a listener, a dropped idle connection would crash the process.
  db.on('error', (error) => settings.log(`Lost an idle database connection: ${error.message}`));

  // Opens nothing until it's used, so it's harmless if `backends` replaces it.
  const postgres = new PostgresBackend();
  const context: WorkerContext = { db, backends: backends ?? { postgres }, decryptCredentials, settings };

  const stopping = new AbortController();
  const runSlot = async () => {
    while (!stopping.signal.aborted) {
      let ran = false;
      try {
        ran = (await processNextJob(context, { accountId })) !== null;
      } catch (error) {
        settings.log(`Could not finish a job: ${(error as Error).message}`);
      }
      if (!ran) await sleep(pollMs, undefined, { signal: stopping.signal }).catch(() => {});
    }
  };
  const slots = Array.from({ length: concurrency }, runSlot);

  // Every worker process sweeps. A repeat only asks for a replay that has little left to do.
  const runSweep = async () => {
    for (;;) {
      await sleep(settings.sweepIntervalMs, undefined, { signal: stopping.signal }).catch(() => {});
      if (stopping.signal.aborted) return;
      await sweepStrandedRows(context, { accountId }).catch((error: Error) =>
        settings.log(`Could not sweep for stranded rows: ${error.message}`),
      );
    }
  };
  const sweep = runSweep();

  let stopped: Promise<void> | undefined;
  return {
    stop() {
      stopped ??= (async () => {
        stopping.abort();
        await Promise.all([...slots, sweep]);
        await Promise.all([db.end(), postgres.close()]);
      })();
      return stopped;
    },
  };
}

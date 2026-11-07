// Adapter records and the gate's inputs, all in the application database (PRD §10, §12.1, §13.1).
import type pg from 'pg';
import type { AdapterRequest, LogicalType } from '../contracts/index.js';
import { fingerprint } from '../fingerprint/index.js';
import type { RegisteredColumns } from '../planner/registry.js';
import { enqueueReplay } from '../worker/queue.js';
import {
  checkOpaquePaths,
  runGate,
  type EarlierVersion,
  type GateOptions,
  type GateResult,
  type GateSample,
} from './gate.js';

export type AdapterOp = 'write' | 'delete';

export const QUARANTINE_REASONS = [
  'unknown_fingerprint',
  'malformed',
  'adapter_error',
  'schema_conflict',
  'write_error',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export interface AdapterRow {
  id: string;
  account_id: string;
  source: string;
  op: AdapterOp;
  fingerprint: string;
  opaque_paths: string[];
  version: number;
  code: string;
  active: boolean;
  validated_at: Date | null;
  superseded_at: Date | null;
  created_at: Date;
}

/** An adapter to validate. The generator can run the gate before storing one, so `id` is optional. */
export type AdapterDraft = Pick<AdapterRow, 'account_id' | 'source' | 'op' | 'fingerprint' | 'opaque_paths' | 'code'> & {
  id?: string;
};

export type NewAdapter = Pick<AdapterRow, 'account_id' | 'source' | 'op' | 'fingerprint' | 'opaque_paths' | 'code'>;

type Queryable = Pick<pg.ClientBase, 'query'>;

const DEFAULT_SAMPLE_LIMIT = 10;
/** Concurrent inserts can pick the same next version. Only the loser of each race retries. */
const MAX_VERSION_ATTEMPTS = 5;
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export interface SampleOptions extends GateOptions {
  sampleLimit?: number;
}

/** Inserts the next version of a shape, inactive. Returns null if the account doesn't exist. */
export async function createAdapter(pool: pg.Pool, adapter: NewAdapter): Promise<AdapterRow | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await pool.query<AdapterRow>(
        `INSERT INTO adapters (account_id, source, op, fingerprint, opaque_paths, code, version)
         SELECT $1, $2, $3, $4, $5::text[], $6, COALESCE(MAX(version), 0) + 1
         FROM adapters
         WHERE account_id = $1 AND source = $2 AND op = $3 AND fingerprint = $4
         RETURNING *`,
        [adapter.account_id, adapter.source, adapter.op, adapter.fingerprint, adapter.opaque_paths, adapter.code],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === FOREIGN_KEY_VIOLATION) return null;
      if (code !== UNIQUE_VIOLATION || attempt >= MAX_VERSION_ATTEMPTS) throw error;
    }
  }
}

export async function getAdapter(db: Queryable, id: string): Promise<AdapterRow | null> {
  const result = await db.query<AdapterRow>('SELECT * FROM adapters WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/** `data_columns` for each store that still receives writes. A store with no columns yet is included. */
export async function loadRegistries(db: Queryable, accountId: string): Promise<Map<string, RegisteredColumns>> {
  const result = await db.query<{
    store_id: string;
    table_name: string | null;
    column_name: string | null;
    logical_type: LogicalType | null;
  }>(
    `SELECT s.id AS store_id, c.table_name, c.column_name, c.logical_type
     FROM account_stores s
     LEFT JOIN data_columns c ON c.store_id = s.id
     WHERE s.account_id = $1 AND s.status <> 'retired'`,
    [accountId],
  );
  const registries = new Map<string, RegisteredColumns>();
  for (const { store_id: storeId, table_name: table, column_name: column, logical_type: type } of result.rows) {
    const registry = registries.get(storeId) ?? new Map<string, Map<string, LogicalType>>();
    registries.set(storeId, registry);
    if (table === null || column === null || type === null) continue;
    const columns = registry.get(table) ?? new Map<string, LogicalType>();
    registry.set(table, columns);
    columns.set(column, type);
  }
  return registries;
}

/** The active version of the same shape, other than this adapter. */
export async function loadEarlierVersion(db: Queryable, adapter: AdapterDraft): Promise<EarlierVersion | undefined> {
  const result = await db.query<Pick<AdapterRow, 'id' | 'code' | 'opaque_paths'>>(
    `SELECT id, code, opaque_paths FROM adapters
     WHERE account_id = $1 AND source = $2 AND op = $3 AND fingerprint = $4 AND active
       AND id IS DISTINCT FROM $5::uuid`,
    [adapter.account_id, adapter.source, adapter.op, adapter.fingerprint, adapter.id ?? null],
  );
  const row = result.rows[0];
  return row && { id: row.id, code: row.code, opaquePaths: row.opaque_paths };
}

/** An open quarantine row that a new adapter could fix (§12.1). */
const FIXABLE_ROW = `SELECT 1 FROM quarantine q
  WHERE q.account_id = e.account_id AND q.event_id = e.id AND q.released_at IS NULL
    AND q.reason IN ('unknown_fingerprint', 'adapter_error', 'schema_conflict')`;
const NEEDS_FIXING = `AND EXISTS (${FIXABLE_ROW})`;
/** Includes `write_error` rows, since the adapter ran and only the write failed. */
const ALREADY_HANDLED = `AND NOT EXISTS (${FIXABLE_ROW})`;

function bodyText(body: Buffer): string | null {
  return body.length === 0 ? null : body.toString('utf8');
}

/** The event full fingerprints this adapter matches (§7.1). Opaque paths need the body to recompute. */
async function matchingFingerprints(db: Queryable, adapter: AdapterDraft, filter: string): Promise<string[]> {
  const matches = new Set([adapter.fingerprint]);
  if (adapter.id) {
    const extra = await db.query<{ fingerprint: string }>(
      'SELECT fingerprint FROM adapter_fingerprints WHERE adapter_id = $1',
      [adapter.id],
    );
    for (const row of extra.rows) matches.add(row.fingerprint);
  }
  if (adapter.opaque_paths.length === 0) return [...matches];

  // Equal full shapes collapse to equal shapes, so one event per full fingerprint is enough.
  const shapes = await db.query<{ fingerprint: string; body: Buffer }>(
    `SELECT e.fingerprint, e.body
     FROM (
       SELECT MAX(e.seq) AS seq
       FROM events e
       WHERE e.account_id = $1 AND e.source = $2 AND e.op = $3 AND e.fingerprint IS NOT NULL ${filter}
       GROUP BY e.fingerprint
     ) latest
     JOIN events e ON e.seq = latest.seq`,
    [adapter.account_id, adapter.source, adapter.op],
  );
  for (const row of shapes.rows) {
    try {
      const text = bodyText(row.body);
      const collapsed = fingerprint(text === null ? null : JSON.parse(text), { opaquePaths: adapter.opaque_paths });
      if (collapsed === adapter.fingerprint) matches.add(row.fingerprint);
    } catch {
      // A body that can't be parsed or nests too deep can't match.
    }
  }
  return [...matches];
}

async function selectSamples(
  db: Queryable,
  adapter: AdapterDraft,
  limit: number,
  filter: string,
): Promise<GateSample[]> {
  const fingerprints = await matchingFingerprints(db, adapter, filter);
  // Newest first, taking turns across full fingerprints, so one busy shape can't crowd out the rest.
  // Each fingerprint stops at `limit` rows, and only those fetch their bodies, so this never sorts a
  // whole shape or carries its bodies.
  const result = await db.query<{ id: string; body: Buffer; request: AdapterRequest }>(
    `SELECT e.id, e.body, e.request
     FROM (
       SELECT picked.id, picked.seq,
              row_number() OVER (PARTITION BY shape ORDER BY picked.seq DESC) AS turn
       FROM unnest($4::text[]) AS shape
       CROSS JOIN LATERAL (
         SELECT e.id, e.seq FROM events e
         WHERE e.account_id = $1 AND e.source = $2 AND e.op = $3 AND e.fingerprint = shape ${filter}
         ORDER BY e.seq DESC
         LIMIT $5
       ) picked
     ) sampled
     JOIN events e ON e.id = sampled.id
     ORDER BY sampled.turn, sampled.seq DESC
     LIMIT $5`,
    [adapter.account_id, adapter.source, adapter.op, fingerprints, limit],
  );
  return result.rows.map((row) => ({ eventId: row.id, body: bodyText(row.body), request: row.request }));
}

/**
 * Samples open quarantine rows of the shape that a new adapter could fix (§13.1). If there are none,
 * it uses the event log, so an operator can still replace an adapter on a healthy shape.
 *
 * `includeHandled` also takes events that aren't waiting on a fix, for up to half the sample. A
 * replacement must keep the columns of the version it replaces, and that version may fail on every
 * open row, leaving nothing to compare without these.
 */
export async function loadSamples(
  db: Queryable,
  adapter: AdapterDraft,
  limit: number = DEFAULT_SAMPLE_LIMIT,
  { includeHandled = false }: { includeHandled?: boolean } = {},
): Promise<GateSample[]> {
  const open = await selectSamples(db, adapter, includeHandled ? Math.ceil(limit / 2) : limit, NEEDS_FIXING);
  const handled = includeHandled ? await selectSamples(db, adapter, limit - open.length, ALREADY_HANDLED) : [];
  const samples = [...open, ...handled];
  return samples.length > 0 ? samples : selectSamples(db, adapter, limit, '');
}

/** Loads everything the gate needs from the database, and runs it. No transaction stays open. */
export async function gateAdapter(
  pool: pg.Pool,
  adapter: AdapterDraft,
  { sampleLimit, ...options }: SampleOptions = {},
): Promise<GateResult> {
  const input = { code: adapter.code, op: adapter.op, opaquePaths: adapter.opaque_paths };
  // Fingerprinting below assumes valid paths, so bad ones have to stop here.
  if (checkOpaquePaths(adapter.opaque_paths).length > 0) {
    return runGate({ adapter: input, samples: [], registries: new Map() }, options);
  }
  const earlier = await loadEarlierVersion(pool, adapter);
  const [samples, registries] = await Promise.all([
    loadSamples(pool, adapter, sampleLimit, { includeHandled: earlier !== undefined }),
    loadRegistries(pool, adapter.account_id),
  ]);
  return runGate({ adapter: input, samples, registries, ...(earlier ? { earlier } : {}) }, options);
}

/** Records that an adapter passed. A failure later doesn't clear this: it records the last pass. */
export async function markValidated(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE adapters SET validated_at = now() WHERE id = $1', [id]);
}

/** Runs the gate on a stored adapter, recording a pass. Returns null if there is no such adapter. */
export async function validateAdapter(
  pool: pg.Pool,
  id: string,
  options: SampleOptions = {},
): Promise<{ adapter: AdapterRow; gate: GateResult } | null> {
  const adapter = await getAdapter(pool, id);
  if (!adapter) return null;
  const gate = await gateAdapter(pool, adapter, options);
  if (gate.ok) await markValidated(pool, id);
  return { adapter, gate };
}

export type ReplayResult = 'enqueued' | 'not_found' | 'not_active';

/** `POST /adapters/:id/replay`. */
export async function requestReplay(pool: pg.Pool, id: string): Promise<ReplayResult> {
  if (await enqueueReplay(pool, id)) return 'enqueued';
  return (await getAdapter(pool, id)) ? 'not_active' : 'not_found';
}

export type ActivationResult =
  | { status: 'activated'; adapter: AdapterRow }
  | { status: 'not_found' }
  /** The adapter has never passed the gate. */
  | { status: 'not_validated' }
  /** Another version went live after the gate ran, so its columns weren't checked. Run the gate again. */
  | { status: 'stale' };

function refusal(
  shape: Pick<AdapterRow, 'id' | 'active' | 'validated_at'>[],
  id: string,
  replacing: string | null,
): ActivationResult | undefined {
  const target = shape.find((row) => row.id === id);
  if (!target) return { status: 'not_found' };
  if (target.validated_at === null) return { status: 'not_validated' };
  const liveOther = shape.find((row) => row.active && row.id !== id);
  return (liveOther?.id ?? null) === replacing ? undefined : { status: 'stale' };
}

/**
 * Makes a validated adapter the live version of its shape and enqueues its replay, atomically. The
 * caller must have just run the gate, and passes the result's `replacing`.
 *
 * `adapters_one_active` can't be deferred, so the old version is deactivated before the new one is set
 * active. Locking the shape's rows first, in a fixed order, makes concurrent activations of a shape
 * take turns, instead of deadlocking or breaking that index.
 */
export async function activateAdapter(
  pool: pg.Pool,
  id: string,
  { replacing }: { replacing: string | null },
): Promise<ActivationResult> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  // The pool only listens to idle clients. Without this, losing the connection between these statements
  // would be an unhandled 'error' event that crashes the process. The next query rejects instead.
  const onError = (error: Error) => {
    brokenConnection = error;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const shape = await client.query<Pick<AdapterRow, 'id' | 'active' | 'validated_at'>>(
      `SELECT id, active, validated_at FROM adapters
       WHERE (account_id, source, op, fingerprint) =
             (SELECT account_id, source, op, fingerprint FROM adapters WHERE id = $1)
       ORDER BY id
       FOR UPDATE`,
      [id],
    );
    const refused = refusal(shape.rows, id, replacing);
    if (refused) {
      await client.query('ROLLBACK');
      return refused;
    }

    const otherIds = shape.rows.filter((row) => row.id !== id).map((row) => row.id);
    await client.query(
      `UPDATE adapters SET active = false, superseded_at = COALESCE(superseded_at, now())
       WHERE id = ANY($1::uuid[])`,
      [otherIds],
    );
    const activated = await client.query<AdapterRow>(
      'UPDATE adapters SET active = true, superseded_at = NULL WHERE id = $1 RETURNING *',
      [id],
    );
    await enqueueReplay(client, id);
    await client.query('COMMIT');
    return { status: 'activated', adapter: activated.rows[0]! };
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: Error) => {
      brokenConnection = rollbackError;
    });
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(brokenConnection);
  }
}

export type ValidateAndActivateResult =
  | ActivationResult
  /** The gate refused it. Nothing changed. */
  | { status: 'failed'; gate: GateResult };

/**
 * `POST /adapters/:id/activate`, and the generator's auto-activate. The gate always runs again, even on
 * an adapter already validated, because the registry and the live version may have moved since.
 */
export async function validateAndActivate(
  pool: pg.Pool,
  id: string,
  options: SampleOptions = {},
): Promise<ValidateAndActivateResult> {
  const validated = await validateAdapter(pool, id, options);
  if (!validated) return { status: 'not_found' };
  if (!validated.gate.ok) return { status: 'failed', gate: validated.gate };
  return activateAdapter(pool, id, { replacing: validated.gate.replacing });
}

export interface QuarantineFilter {
  accountId: string;
  source?: string;
  op?: AdapterOp;
  fingerprint?: string;
  reason?: QuarantineReason;
  limit: number;
  offset: number;
}

export interface QuarantineEntry {
  id: string;
  event_id: string;
  store_id: string | null;
  source: string;
  op: AdapterOp;
  fingerprint: string | null;
  reason: QuarantineReason;
  detail: string | null;
  quarantined_at: Date;
  request: AdapterRequest;
  /** The body's size. Payloads have no size limit, so a listing leaves out the body itself. */
  body_bytes: number;
}

/** `GET /quarantine`: unreleased rows for one account, newest first. */
export async function listQuarantine(db: Queryable, filter: QuarantineFilter): Promise<QuarantineEntry[]> {
  const result = await db.query<QuarantineEntry>(
    `SELECT q.id, q.event_id, q.store_id, e.source, e.op, e.fingerprint, q.reason, q.detail,
            q.quarantined_at, e.request, octet_length(e.body) AS body_bytes
     FROM quarantine q
     JOIN events e ON e.account_id = q.account_id AND e.id = q.event_id
     WHERE q.account_id = $1 AND q.released_at IS NULL
       AND ($2::text IS NULL OR e.source = $2)
       AND ($3::text IS NULL OR e.op = $3)
       AND ($4::text IS NULL OR e.fingerprint = $4)
       AND ($5::text IS NULL OR q.reason = $5)
     ORDER BY q.quarantined_at DESC, q.id
     LIMIT $6 OFFSET $7`,
    [
      filter.accountId,
      filter.source ?? null,
      filter.op ?? null,
      filter.fingerprint ?? null,
      filter.reason ?? null,
      filter.limit,
      filter.offset,
    ],
  );
  return result.rows;
}

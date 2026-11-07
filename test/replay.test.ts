import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StorageError, type SchemaChange, type StorageBackend, type StoreConfig, type TableRows } from '../src/contracts/index.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import {
  DEFAULT_SETTINGS,
  enqueueReplay,
  processNextJob,
  startWorker,
  sweepStrandedRows,
  type WorkerContext,
} from '../src/worker/index.js';
import { claimJob, finishReplay } from '../src/worker/queue.js';

// Databases and child processes add up, particularly when other test files are busy too.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const config = loadConfig();
const db = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 12 });
const dataUrl = new URL(config.dataDatabaseUrl);
const dataConnection = {
  host: dataUrl.hostname,
  port: Number(dataUrl.port),
  database: dataUrl.pathname.slice(1),
};
const dataCredentials = {
  user: decodeURIComponent(dataUrl.username),
  password: decodeURIComponent(dataUrl.password),
};
const admin = new pg.Pool({ ...dataConnection, ...dataCredentials, max: 1 });
const realBackend = new PostgresBackend({ idleTimeoutMs: 50 });

const accounts: string[] = [];
const scratchDatabases: string[] = [];

/** The real backend, with hooks to fail or act around its writes. */
class HookedBackend implements StorageBackend {
  readonly capabilities = realBackend.capabilities;
  writes: { namespace: string; ids: unknown[] }[] = [];
  beforeWrite: ((writeNumber: number) => Promise<void>) | undefined;
  afterWrite: ((writeNumber: number) => Promise<void>) | undefined;

  provision(store: StoreConfig): Promise<Record<string, unknown>> {
    return realBackend.provision(store);
  }
  applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void> {
    return realBackend.applySchema(store, changes);
  }
  async write(store: StoreConfig, tables: TableRows[]): Promise<void> {
    const writeNumber = this.writes.length + 1;
    this.writes.push({ namespace: store.namespace, ids: tables.flatMap(({ rows }) => rows.map(({ id }) => id)) });
    await this.beforeWrite?.(writeNumber);
    await realBackend.write(store, tables);
    await this.afterWrite?.(writeNumber);
  }
  health(store: StoreConfig): Promise<void> {
    return realBackend.health(store);
  }
}

let backend: HookedBackend;

function context(settings: Partial<WorkerContext['settings']> = {}): WorkerContext {
  return {
    db,
    backends: { postgres: backend },
    decryptCredentials: (encrypted) => JSON.parse(encrypted.toString('utf8')) as Record<string, unknown>,
    settings: { ...DEFAULT_SETTINGS, log: () => {}, ...settings },
  };
}

const request = { method: 'POST', path: '/ingest', query: '', headers: {} };

async function newAccount(): Promise<string> {
  const id = randomUUID();
  accounts.push(id);
  await db.query('INSERT INTO accounts (id, slug) VALUES ($1, $2)', [id, `replay-${id}`]);
  return id;
}

let generation = 0;

async function addStore(accountId: string, status = 'active'): Promise<{ id: string; namespace: string }> {
  const namespace = `t_${randomBytes(6).toString('hex')}_replay`;
  scratchDatabases.push(namespace);
  await realBackend.provision({ namespace, connection: dataConnection, credentials: dataCredentials });
  const id = randomUUID();
  await db.query(
    `INSERT INTO account_stores (id, account_id, generation, backend, connection, credentials, namespace, status)
     VALUES ($1, $2, $3, 'postgres', $4, $5, $6, $7)`,
    [id, accountId, ++generation, dataConnection, Buffer.from(JSON.stringify(dataCredentials)), namespace, status],
  );
  return { id, namespace };
}

async function inStore<T extends pg.QueryResultRow>(namespace: string, sql: string): Promise<T[]> {
  const client = new pg.Client({ ...dataConnection, ...dataCredentials, database: namespace });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

/** A table's rows, or nothing if the table was never created. */
async function usersIn(namespace: string): Promise<{ id: string; name: string }[]> {
  const tables = await inStore(namespace, `SELECT 1 FROM pg_tables WHERE tablename = 'user'`);
  if (tables.length === 0) return [];
  return inStore(namespace, 'SELECT id, name FROM "user" ORDER BY id');
}

async function addAdapter(
  accountId: string,
  options: {
    code?: string;
    shape?: unknown;
    opaquePaths?: string[];
    source?: string;
    op?: string;
    active?: boolean;
    version?: number;
    alsoMatches?: unknown[];
  } = {},
): Promise<string> {
  const id = randomUUID();
  const opaquePaths = options.opaquePaths ?? [];
  await db.query(
    `INSERT INTO adapters
       (id, account_id, source, op, fingerprint, opaque_paths, version, code, active, validated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      id,
      accountId,
      options.source ?? '',
      options.op ?? 'write',
      fingerprint(options.shape ?? userBody('x'), { opaquePaths }),
      opaquePaths,
      options.version ?? 1,
      options.code ?? userAdapter,
      options.active ?? true,
    ],
  );
  for (const shape of options.alsoMatches ?? []) {
    await db.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [id, fingerprint(shape)]);
  }
  return id;
}

/** An event already in quarantine, as if no adapter matched it at ingest. */
async function addQuarantined(
  accountId: string,
  body: unknown,
  options: {
    source?: string;
    op?: string;
    reason?: string;
    storeId?: string | null;
    receivedAt?: string;
    malformed?: boolean;
    eventId?: string;
  } = {},
): Promise<{ rowId: string; eventId: string }> {
  let eventId = options.eventId;
  if (!eventId) {
    const event = await db.query<{ id: string }>(
      `INSERT INTO events (account_id, body, source, op, fingerprint, request, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now())) RETURNING id`,
      [
        accountId,
        Buffer.from(JSON.stringify(body), 'utf8'),
        options.source ?? '',
        options.op ?? 'write',
        options.malformed ? null : fingerprint(body),
        request,
        options.receivedAt ?? null,
      ],
    );
    eventId = event.rows[0]!.id;
  }
  const row = await db.query<{ id: string }>(
    `INSERT INTO quarantine (event_id, account_id, store_id, reason, detail)
     VALUES ($1, $2, $3, $4, 'original detail') RETURNING id`,
    [eventId, accountId, options.storeId ?? null, options.reason ?? 'unknown_fingerprint'],
  );
  return { rowId: row.rows[0]!.id, eventId };
}

async function addJob(accountId: string, adapterId: string, ageHours = 0): Promise<string> {
  const job = await db.query<{ id: string }>(
    `INSERT INTO queue (account_id, kind, adapter_id, created_at)
     VALUES ($1, 'replay', $2, now() - $3::double precision * interval '1 hour') RETURNING id`,
    [accountId, adapterId, ageHours],
  );
  return job.rows[0]!.id;
}

async function jobRow(jobId: string) {
  const result = await db.query<{
    attempts: number;
    rerun_requested: boolean;
    ready: boolean;
    age_s: number;
    delay_ms: number;
  }>(
    `SELECT attempts, rerun_requested, run_at <= now() AS ready,
       extract(epoch FROM now() - created_at)::double precision AS age_s,
       (extract(epoch FROM run_at - now()) * 1000)::double precision AS delay_ms
     FROM queue WHERE id = $1`,
    [jobId],
  );
  return result.rows[0];
}

async function makeReady(jobId: string): Promise<void> {
  await db.query(`UPDATE queue SET run_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
}

async function row(rowId: string) {
  const result = await db.query<{
    reason: string;
    detail: string;
    released_at: Date | null;
    released_by_adapter_id: string | null;
  }>('SELECT reason, detail, released_at, released_by_adapter_id FROM quarantine WHERE id = $1', [rowId]);
  return result.rows[0]!;
}

async function logFor(rowId: string) {
  const result = await db.query<{ account_id: string; adapter_id: string; status: string; detail: string | null }>(
    'SELECT account_id, adapter_id, status, detail FROM replay_log WHERE quarantine_id = $1 ORDER BY id',
    [rowId],
  );
  return result.rows;
}

function userBody(id: string): { id: string; name: string } {
  return { id, name: `name-${id}` };
}

/** Throws for the event whose `id` is `boom`, so one failing row can sit among good ones. */
const userAdapter = `function adapt(payload) {
  if (payload.data.id === 'boom') throw new Error('boom');
  return { table: 'user', rows: [{ id: payload.data.id, name: payload.data.name }] };
}`;

beforeEach(() => {
  backend = new HookedBackend();
});

afterAll(async () => {
  const ids = [accounts];
  await db.query('DELETE FROM queue WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM replay_log WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM quarantine WHERE account_id = ANY($1)', ids);
  await db.query(
    `DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = ANY($1))`,
    ids,
  );
  await db.query('DELETE FROM adapters WHERE account_id = ANY($1)', ids);
  await db.query(
    `DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = ANY($1))`,
    ids,
  );
  await db.query('DELETE FROM events WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM account_stores WHERE account_id = ANY($1)', ids);
  await db.query('DELETE FROM accounts WHERE id = ANY($1)', ids);
  await db.end();
  await realBackend.close();
  for (const namespace of scratchDatabases) {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
  await admin.end();
});

describe('releasing rows', () => {
  it('writes each row, releases it, logs it under its account, and deletes the job', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const a = await addQuarantined(accountId, userBody('a'));
    const b = await addQuarantined(accountId, userBody('b'));
    const jobId = await addJob(accountId, adapterId);

    const result = await processNextJob(context(), { accountId });

    expect(result?.outcome).toBe('done');
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await usersIn(namespace)).toEqual([
      { id: 'a', name: 'name-a' },
      { id: 'b', name: 'name-b' },
    ]);
    for (const { rowId } of [a, b]) {
      expect(await row(rowId)).toMatchObject({ released_by_adapter_id: adapterId });
      expect((await row(rowId)).released_at).not.toBeNull();
      expect(await logFor(rowId)).toEqual([
        { account_id: accountId, adapter_id: adapterId, status: 'released', detail: null },
      ]);
    }
  });

  it('writes exactly what ingest wrote: same IDs, _event_seq, and _deleted_at to the microsecond', async () => {
    const accountId = await newAccount();
    const active = await addStore(accountId);
    const body = { id: 'u1', orders: [{ sku: 'A' }, { sku: 'B' }] };
    const code = `function adapt(payload) {
      return {
        table: 'user',
        rows: [{
          id: payload.data.id,
          _deleted: true,
          children: { orders: { rows: payload.data.orders.map((o) => ({ sku: o.sku })) } },
        }],
      };
    }`;
    const adapterId = await addAdapter(accountId, { shape: body, op: 'delete', code });

    // Ingest writes the event to the active store. A row naming a second store then replays it there.
    const event = await db.query<{ id: string }>(
      `INSERT INTO events (account_id, body, op, fingerprint, request, received_at)
       VALUES ($1, $2, 'delete', $3, $4, '2026-11-07T12:00:00.123456Z') RETURNING id`,
      [accountId, Buffer.from(JSON.stringify(body)), fingerprint(body), request],
    );
    const eventId = event.rows[0]!.id;
    await db.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [accountId, eventId]);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    const second = await addStore(accountId, 'ready');
    await addQuarantined(accountId, body, { eventId, storeId: second.id, reason: 'write_error' });
    await addJob(accountId, adapterId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    const read = (namespace: string, table: string) =>
      inStore(
        namespace,
        `SELECT id, _event_seq::text AS seq,
           to_char(_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted
         FROM ${table} ORDER BY id`,
      );
    const users = await read(second.namespace, '"user"');
    expect(users).toMatchObject([{ id: 'u1', deleted: '2026-11-07T12:00:00.123456Z' }]);
    expect(users).toEqual(await read(active.namespace, '"user"'));
    const orders = await read(second.namespace, 'user_orders');
    expect(orders).toHaveLength(2);
    expect(orders).toEqual(await read(active.namespace, 'user_orders'));
  });

  it('releases rows with any open reason except malformed', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const failed = await addQuarantined(accountId, userBody('a'), { reason: 'adapter_error' });
    const conflict = await addQuarantined(accountId, userBody('b'), { reason: 'schema_conflict' });
    const malformedReason = await addQuarantined(accountId, userBody('c'), { reason: 'malformed' });
    const malformed = await addQuarantined(accountId, 'just a string', { reason: 'malformed', malformed: true });
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect((await row(failed.rowId)).released_at).not.toBeNull();
    expect((await row(conflict.rowId)).released_at).not.toBeNull();
    expect(await row(malformedReason.rowId)).toMatchObject({ released_at: null, reason: 'malformed', detail: 'original detail' });
    expect(await row(malformed.rowId)).toMatchObject({ released_at: null, reason: 'malformed' });
    expect(await logFor(malformed.rowId)).toEqual([]);
  });

  it('leaves other shapes, sources, ops, and accounts alone', async () => {
    const accountId = await newAccount();
    const other = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const mine = await addQuarantined(accountId, userBody('a'));
    const rows = [
      await addQuarantined(accountId, { id: 'a', name: 'n', extra: 1 }),
      await addQuarantined(accountId, userBody('a'), { source: 'stripe' }),
      await addQuarantined(accountId, userBody('a'), { op: 'delete' }),
      await addQuarantined(other, userBody('a')),
    ];
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect((await row(mine.rowId)).released_at).not.toBeNull();
    for (const { rowId } of rows) {
      expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint' });
    }
  });

  it('pages through every row in seq order, once each, across a batch boundary', async () => {
    const accountId = await newAccount();
    const { id: storeId, namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const rows = [];
    for (const id of ['a', 'b', 'c', 'boom', 'd']) rows.push(await addQuarantined(accountId, userBody(id)));
    // A second open row for one event sits right on a page boundary, with the same seq.
    await addStore(accountId, 'ready');
    const secondForC = await addQuarantined(accountId, null, { eventId: rows[2]!.eventId, storeId });
    await addJob(accountId, adapterId);

    expect((await processNextJob(context({ replayBatchSize: 2 }), { accountId }))?.outcome).toBe('done');

    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
    const ids = backend.writes.flatMap((write) => write.ids);
    expect(ids.filter((id) => id === 'a')).toHaveLength(2); // the active and the ready store
    expect(ids.filter((id) => id === 'c')).toHaveLength(3); // both stores, then the row naming one
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.lastIndexOf('c')).toBeLessThan(ids.indexOf('d'));
    expect((await row(secondForC.rowId)).released_at).not.toBeNull();
    expect(await logFor(rows[3]!.rowId)).toHaveLength(1);
  });
});

describe('matching', () => {
  it('uses an exact fingerprint and adapter_fingerprints, but not unrelated shapes', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const also = { id: 'b', name: 'n', nickname: 'x' };
    const adapterId = await addAdapter(accountId, { alsoMatches: [also] });
    await addQuarantined(accountId, userBody('a'));
    await addQuarantined(accountId, also);
    const unrelated = await addQuarantined(accountId, { id: 'c', name: 'n', age: 3 });
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a', 'b']);
    expect((await row(unrelated.rowId)).released_at).toBeNull();
  });

  it('matches through opaque paths', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId, {
      shape: { id: 'x', name: 'n', metadata: { k: 'v' } },
      opaquePaths: ['metadata'],
    });
    await addQuarantined(accountId, { id: 'a', name: 'n', metadata: { anything: 1 } });
    await addQuarantined(accountId, { id: 'b', name: 'n', metadata: { other: 'x', keys: true } });
    const unrelated = await addQuarantined(accountId, { id: 'c', metadata: { anything: 1 } });
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a', 'b']);
    expect((await row(unrelated.rowId)).released_at).toBeNull();
  });

  it('leaves a row to the adapter §7.1 would choose for it', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const specificShape = { id: 'x', name: 'n', metadata: { special: 1 } };
    const opaqueId = await addAdapter(accountId, {
      shape: { id: 'x', name: 'n', metadata: { k: 'v' } },
      opaquePaths: ['metadata'],
    });
    const specificId = await addAdapter(accountId, { shape: specificShape });
    const caught = await addQuarantined(accountId, { id: 'a', name: 'n', metadata: { any: 'thing' } });
    const specific = await addQuarantined(accountId, { id: 'b', name: 'n', metadata: { special: 2 } });
    const opaqueJob = await addJob(accountId, opaqueId);

    await processNextJob(context(), { accountId });

    expect(await jobRow(opaqueJob)).toBeUndefined();
    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a']);
    expect(await row(caught.rowId)).toMatchObject({ released_by_adapter_id: opaqueId });
    expect(await row(specific.rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint' });

    await addJob(accountId, specificId);
    await processNextJob(context(), { accountId });
    expect(await row(specific.rowId)).toMatchObject({ released_by_adapter_id: specificId });
  });

  it('touches nothing if the adapter is no longer active', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId, { active: false });
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(await jobRow(jobId)).toBeUndefined();
    expect(backend.writes).toEqual([]);
    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint' });
  });

  it('hands over to a new version activated partway through', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const oldId = await addAdapter(accountId);
    const newCode = `function adapt(payload) {
      return { table: 'user', rows: [{ id: payload.data.id, name: 'v2' }] };
    }`;
    const newId = await addAdapter(accountId, { active: false, version: 2, code: newCode });
    const first = await addQuarantined(accountId, userBody('a'));
    const second = await addQuarantined(accountId, userBody('b'));
    await addJob(accountId, oldId);
    backend.afterWrite = async (writeNumber) => {
      if (writeNumber !== 1) return;
      await db.query('UPDATE adapters SET active = false WHERE id = $1', [oldId]);
      await db.query('UPDATE adapters SET active = true WHERE id = $1', [newId]);
      await enqueueReplay(db, newId);
    };

    // Both rows are on one page, and the old version still stops at the second.
    expect((await processNextJob(context(), { accountId }))?.job.adapterId).toBe(oldId);
    expect(await row(first.rowId)).toMatchObject({ released_by_adapter_id: oldId });
    expect(await row(second.rowId)).toMatchObject({ released_at: null });

    expect((await processNextJob(context(), { accountId }))?.job.adapterId).toBe(newId);
    expect(await row(second.rowId)).toMatchObject({ released_by_adapter_id: newId });
    expect(await usersIn(namespace)).toEqual([
      { id: 'a', name: 'name-a' },
      { id: 'b', name: 'v2' },
    ]);
  });
});

describe('which stores', () => {
  it('writes a row with no store to every live store, active first, and never a retired one', async () => {
    const accountId = await newAccount();
    const retired = await addStore(accountId, 'retired');
    const building = await addStore(accountId, 'building');
    const active = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    await addQuarantined(accountId, userBody('a'));
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect(backend.writes.map(({ namespace }) => namespace)).toEqual([active.namespace, building.namespace]);
    expect(await usersIn(retired.namespace)).toEqual([]);
  });

  it('writes a row naming a store only to that store', async () => {
    const accountId = await newAccount();
    const active = await addStore(accountId);
    const building = await addStore(accountId, 'building');
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'), { storeId: building.id, reason: 'write_error' });
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect(await usersIn(building.namespace)).toHaveLength(1);
    expect(await usersIn(active.namespace)).toEqual([]);
    expect((await row(rowId)).released_at).not.toBeNull();
  });

  it('fails a row naming a retired store, without writing to it', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const retired = await addStore(accountId, 'retired');
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'), { storeId: retired.id });
    await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(backend.writes).toEqual([]);
    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'write_error' });
    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
  });

  describe('when only some live stores take the write', () => {
    const rejected = () => new StorageError('rejected', { retryable: false });

    async function openRows(eventId: string) {
      const result = await db.query<{ id: string; store_id: string | null; reason: string; detail: string }>(
        'SELECT id, store_id, reason, detail FROM quarantine WHERE event_id = $1 AND released_at IS NULL',
        [eventId],
      );
      return result.rows;
    }

    /** An active store that works, a building store that rejects writes, and one open row for both. */
    async function setUp() {
      const accountId = await newAccount();
      const active = await addStore(accountId);
      const building = await addStore(accountId, 'building');
      const adapterId = await addAdapter(accountId);
      const { rowId, eventId } = await addQuarantined(accountId, userBody('a'));
      await addJob(accountId, adapterId);
      backend.beforeWrite = async () => {
        if (backend.writes.at(-1)?.namespace === building.namespace) throw rejected();
      };
      return { accountId, active, building, adapterId, rowId, eventId };
    }

    it('releases the row, and opens one against just the failed store', async () => {
      const { accountId, active, building, adapterId, rowId, eventId } = await setUp();

      expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

      expect(await row(rowId)).toMatchObject({ released_by_adapter_id: adapterId });
      expect((await row(rowId)).released_at).not.toBeNull();
      expect(await openRows(eventId)).toMatchObject([
        { store_id: building.id, reason: 'write_error', detail: 'rejected' },
      ]);
      expect(await usersIn(active.namespace)).toHaveLength(1);
      expect(await usersIn(building.namespace)).toEqual([]);
    });

    it('logs nothing as failed, so it cannot count against the generator cap', async () => {
      const { accountId, adapterId, rowId, eventId } = await setUp();

      await processNextJob(context(), { accountId });
      expect(await enqueueReplay(db, adapterId)).toBe(true);
      await processNextJob(context(), { accountId });

      const [narrowed] = await openRows(eventId);
      expect(await logFor(rowId)).toEqual([
        { account_id: accountId, adapter_id: adapterId, status: 'released', detail: null },
      ]);
      expect(await logFor(narrowed!.id)).toEqual([
        { account_id: accountId, adapter_id: adapterId, status: 'store_failed', detail: 'write_error: rejected' },
        { account_id: accountId, adapter_id: adapterId, status: 'store_failed', detail: 'write_error: rejected' },
      ]);
    });

    it('stays one row through repeats, writes only the failed store, and closes when it recovers', async () => {
      const { accountId, active, building, adapterId, eventId } = await setUp();
      await processNextJob(context(), { accountId });

      backend.writes = [];
      await enqueueReplay(db, adapterId);
      expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
      expect(backend.writes.map(({ namespace }) => namespace)).toEqual([building.namespace]);
      expect(await openRows(eventId)).toHaveLength(1);

      backend.beforeWrite = undefined;
      await enqueueReplay(db, adapterId);
      expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
      expect(await openRows(eventId)).toEqual([]);
      expect(await usersIn(building.namespace)).toHaveLength(1);
      expect(await usersIn(active.namespace)).toHaveLength(1);
    });

    it('updates a row already open against that store, rather than adding another', async () => {
      const { accountId, building, eventId } = await setUp();
      const existing = await addQuarantined(accountId, null, { eventId, storeId: building.id, reason: 'schema_conflict' });

      await processNextJob(context(), { accountId });

      // The existing row is replayed too, and fails again on its own store.
      expect(await openRows(eventId)).toMatchObject([
        { id: existing.rowId, store_id: building.id, reason: 'write_error', detail: 'rejected' },
      ]);
    });

    it('opens one row when a stalled worker finishes after another has already narrowed it', async () => {
      const { accountId, rowId, eventId } = await setUp();
      const jobs = await db.query<{ id: string }>('SELECT id FROM queue WHERE account_id = $1', [accountId]);
      let resume = () => {};
      const stalled = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const rejectBuilding = backend.beforeWrite!;
      backend.beforeWrite = async (writeNumber) => {
        if (writeNumber === 2) await stalled;
        await rejectBuilding(writeNumber);
      };

      const first = processNextJob(context(), { accountId });
      await vi.waitFor(() => expect(backend.writes).toHaveLength(2), { timeout: 30_000 });
      const second = new HookedBackend();
      second.beforeWrite = async () => {
        if (second.writes.length % 2 === 0) throw rejected();
      };
      await makeReady(jobs.rows[0]!.id);
      const secondContext = { ...context(), backends: { postgres: second } };
      expect((await processNextJob(secondContext, { accountId }))?.outcome).toBe('done');

      resume();
      expect((await first)?.outcome).toBe('lease_lost');

      const open = await openRows(eventId);
      expect(open).toHaveLength(1);
      expect(await logFor(rowId)).toMatchObject([{ status: 'released' }]);
      expect(await logFor(open[0]!.id)).toMatchObject([{ status: 'store_failed' }]);
    });

    it('opens a row for each store that failed, when one still took the write', async () => {
      const accountId = await newAccount();
      const active = await addStore(accountId);
      const ready = await addStore(accountId, 'ready');
      const building = await addStore(accountId, 'building');
      const adapterId = await addAdapter(accountId);
      const { eventId } = await addQuarantined(accountId, userBody('a'));
      await addJob(accountId, adapterId);
      backend.beforeWrite = async () => {
        if (backend.writes.at(-1)?.namespace !== active.namespace) throw rejected();
      };

      await processNextJob(context(), { accountId });

      const open = await openRows(eventId);
      expect(open.map(({ store_id: storeId }) => storeId).sort()).toEqual([ready.id, building.id].sort());
    });

    it('narrows to a store still failing transiently at the maximum age', async () => {
      const accountId = await newAccount();
      await addStore(accountId);
      const building = await addStore(accountId, 'building');
      const adapterId = await addAdapter(accountId);
      const { rowId, eventId } = await addQuarantined(accountId, userBody('a'));
      await addJob(accountId, adapterId, 73);
      backend.beforeWrite = async () => {
        if (backend.writes.at(-1)?.namespace === building.namespace) {
          throw new StorageError('down', { retryable: true });
        }
      };

      expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

      expect((await row(rowId)).released_at).not.toBeNull();
      expect(await openRows(eventId)).toMatchObject([
        { store_id: building.id, reason: 'write_error', detail: 'Still failing at the maximum age: down' },
      ]);
    });

    it('keeps the row, logged as failed, when no store took the write', async () => {
      const accountId = await newAccount();
      const active = await addStore(accountId);
      const building = await addStore(accountId, 'building');
      const adapterId = await addAdapter(accountId);
      const { rowId, eventId } = await addQuarantined(accountId, userBody('a'));
      await addJob(accountId, adapterId);
      backend.beforeWrite = async () => {
        throw rejected();
      };

      await processNextJob(context(), { accountId });

      expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'write_error' });
      expect((await row(rowId)).detail).toBe(`Store ${active.id}: rejected; Store ${building.id}: rejected`);
      expect(await openRows(eventId)).toHaveLength(1);
      expect(await logFor(rowId)).toMatchObject([{ status: 'failed' }]);
    });
  });
});

describe('rows that fail', () => {
  it('keeps the row open with its new reason, logs it, and carries on', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const before = await addQuarantined(accountId, userBody('a'));
    const bad = await addQuarantined(accountId, userBody('boom'));
    const after = await addQuarantined(accountId, userBody('b'));
    const jobId = await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(await jobRow(jobId)).toBeUndefined();
    expect((await row(before.rowId)).released_at).not.toBeNull();
    expect((await row(after.rowId)).released_at).not.toBeNull();
    const failed = await row(bad.rowId);
    expect(failed).toMatchObject({ released_at: null, reason: 'adapter_error' });
    expect(failed.detail).toContain('boom');
    const log = await logFor(bad.rowId);
    expect(log).toMatchObject([{ account_id: accountId, adapter_id: adapterId, status: 'failed' }]);
    expect(log[0]!.detail).toContain('adapter_error');
    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a', 'b']);
    // The adapter stays active (§15).
    const adapter = await db.query('SELECT active FROM adapters WHERE id = $1', [adapterId]);
    expect(adapter.rows).toEqual([{ active: true }]);
  });

  it('records a type conflict with the registered column as schema_conflict', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId, {
      shape: { id: 'x', name: 1 },
      code: `function adapt(payload) { return { table: 'user', rows: [{ id: payload.data.id, name: payload.data.name }] }; }`,
      alsoMatches: [userBody('x')],
    });
    const good = await addQuarantined(accountId, { id: 'a', name: 1 });
    const conflict = await addQuarantined(accountId, userBody('b'));
    await addJob(accountId, adapterId);

    await processNextJob(context(), { accountId });

    expect((await row(good.rowId)).released_at).not.toBeNull();
    expect(await row(conflict.rowId)).toMatchObject({ released_at: null, reason: 'schema_conflict' });
    expect(await logFor(conflict.rowId)).toMatchObject([{ status: 'failed' }]);
  });

  it('records a write the backend permanently rejects as write_error', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    // A NUL byte can't go in a Postgres TEXT column.
    const bad = await addQuarantined(accountId, { id: 'a', name: 'x\u0000y' });
    await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(await row(bad.rowId)).toMatchObject({ released_at: null, reason: 'write_error' });
  });
});

describe('transient failures', () => {
  it('survives a real backend outage, with rows unchanged, then finishes', async () => {
    const accountId = await newAccount();
    const { id: storeId, namespace } = await addStore(accountId);
    await db.query('UPDATE account_stores SET connection = $2 WHERE id = $1', [storeId, { ...dataConnection, port: 1 }]);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');

    const queued = await jobRow(jobId);
    expect(queued?.delay_ms).toBeGreaterThan(0);
    expect(queued?.delay_ms).toBeLessThanOrEqual(DEFAULT_SETTINGS.backoffBaseMs);
    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint', detail: 'original detail' });
    expect(await logFor(rowId)).toEqual([]);

    await db.query('UPDATE account_stores SET connection = $2 WHERE id = $1', [storeId, dataConnection]);
    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await usersIn(namespace)).toHaveLength(1);
    expect(await logFor(rowId)).toMatchObject([{ status: 'released' }]);
  });

  it('stops at the failure, and the retry does not repeat released rows', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const rows = [];
    for (const id of ['a', 'b', 'c']) rows.push(await addQuarantined(accountId, userBody(id)));
    const jobId = await addJob(accountId, adapterId);
    backend.beforeWrite = async (writeNumber) => {
      if (writeNumber === 2) throw new StorageError('down', { retryable: true });
    };

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');

    expect(backend.writes.flatMap(({ ids }) => ids)).toEqual(['a', 'b']);
    expect((await row(rows[0]!.rowId)).released_at).not.toBeNull();
    expect((await row(rows[1]!.rowId)).released_at).toBeNull();
    expect((await row(rows[2]!.rowId)).released_at).toBeNull();

    backend.writes = [];
    backend.beforeWrite = undefined;
    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(backend.writes.flatMap(({ ids }) => ids)).toEqual(['b', 'c']);
    expect(await usersIn(namespace)).toHaveLength(3);
    for (const { rowId } of rows) expect(await logFor(rowId)).toMatchObject([{ status: 'released' }]);
  });

  it('retries when the account has no live store', async () => {
    const accountId = await newAccount();
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    await addJob(accountId, adapterId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint' });
  });

  it('records write_error at the maximum age, and carries on through the rest', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const first = await addQuarantined(accountId, userBody('a'));
    const second = await addQuarantined(accountId, userBody('b'));
    const jobId = await addJob(accountId, adapterId, 73);
    backend.beforeWrite = async (writeNumber) => {
      if (writeNumber === 1) throw new StorageError('down', { retryable: true });
    };

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(await jobRow(jobId)).toBeUndefined();
    const failed = await row(first.rowId);
    expect(failed).toMatchObject({ released_at: null, reason: 'write_error' });
    expect(failed.detail).toContain('Still failing at the maximum age: down');
    expect((await row(second.rowId)).released_at).not.toBeNull();
  });

  it('records a permanent failure at once, even while another store is still retrying', async () => {
    const accountId = await newAccount();
    const active = await addStore(accountId);
    await addStore(accountId, 'building');
    const adapterId = await addAdapter(accountId);
    const { rowId, eventId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);
    backend.beforeWrite = async (writeNumber) => {
      if (writeNumber === 1) throw new StorageError('rejected', { retryable: false });
      throw new StorageError('down', { retryable: true });
    };

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');

    const open = await row(rowId);
    expect(open).toMatchObject({ released_at: null, reason: 'write_error' });
    expect(open.detail).toBe(`Store ${active.id}: rejected`);
    expect(await logFor(rowId)).toMatchObject([{ status: 'store_failed' }]);
    expect(await jobRow(jobId)).toBeDefined();

    // The other store recovers, so the row narrows to the one that failed for good.
    backend.writes = [];
    backend.beforeWrite = async (writeNumber) => {
      if (writeNumber === 1) throw new StorageError('rejected', { retryable: false });
    };
    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect((await row(rowId)).released_at).not.toBeNull();
    const narrowed = await db.query(
      'SELECT store_id FROM quarantine WHERE event_id = $1 AND released_at IS NULL',
      [eventId],
    );
    expect(narrowed.rows).toEqual([{ store_id: active.id }]);
  });

  it('does not blame a row when the adapter lookup fails, even past the maximum age', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId, 73);
    const failing = new Proxy(db, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property);
        return (text: unknown, values: unknown) => {
          if (typeof text === 'string' && text.includes('AS "opaquePaths"')) {
            return Promise.reject(new Error('query timeout'));
          }
          return target.query(text as string, values as unknown[]);
        };
      },
    });

    expect((await processNextJob({ ...context(), db: failing }, { accountId }))?.outcome).toBe('retry');

    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'unknown_fingerprint', detail: 'original detail' });
    expect(await logFor(rowId)).toEqual([]);
    expect(await jobRow(jobId)).toBeDefined();
  });

  it('retries when the application database fails partway through', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);

    // Fails only the release, so the write has landed: a crash at the worst moment.
    const flaky = new Proxy(db, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property);
        return (text: unknown, values: unknown) => {
          if (typeof text === 'string' && text.includes('released_at = now()')) {
            return Promise.reject(new Error('connection lost'));
          }
          return target.query(text as string, values as unknown[]);
        };
      },
    });

    expect((await processNextJob({ ...context(), db: flaky }, { accountId }))?.outcome).toBe('retry');
    expect((await row(rowId)).released_at).toBeNull();
    expect(await usersIn(namespace)).toHaveLength(1);

    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await usersIn(namespace)).toHaveLength(1);
    expect(await logFor(rowId)).toMatchObject([{ status: 'released' }]);
  });
});

describe('interrupted and repeated replays', () => {
  it('recovers when a job is claimed and then abandoned before doing anything', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);

    expect(await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId })).not.toBeNull();
    expect(await processNextJob(context(), { accountId })).toBeNull();

    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await usersIn(namespace)).toHaveLength(1);
  });

  it('changes nothing when a finished replay runs again', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const failing = await addQuarantined(accountId, userBody('boom'));
    await addJob(accountId, adapterId);
    await processNextJob(context(), { accountId });
    const before = await row(rowId);
    backend.writes = [];

    expect(await enqueueReplay(db, adapterId)).toBe(true);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect(backend.writes).toEqual([]);
    expect(await row(rowId)).toEqual(before);
    expect(await logFor(rowId)).toHaveLength(1);
    expect(await usersIn(namespace)).toEqual([{ id: 'a', name: 'name-a' }]);
    // A failed row stays open, so an explicit replay tries it again.
    expect(await logFor(failing.rowId)).toHaveLength(2);
    expect(await row(failing.rowId)).toMatchObject({ released_at: null, reason: 'adapter_error' });
  });

  it('produces no duplicates when a worker stalls after a write and another repeats the row', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const body = { id: 'u1', name: 'Ada', orders: [{ sku: 'A' }] };
    const adapterId = await addAdapter(accountId, {
      shape: body,
      code: `function adapt(payload) {
        const d = payload.data;
        return { table: 'user', rows: [{ id: d.id, name: d.name, children: { orders: { rows: d.orders.map((o) => ({ sku: o.sku })) } } }] };
      }`,
    });
    const { rowId } = await addQuarantined(accountId, body);
    const jobId = await addJob(accountId, adapterId);

    // The write lands and the worker stalls before releasing, which is also what a dead worker leaves.
    let resume = () => {};
    const stalled = new Promise<void>((resolve) => {
      resume = resolve;
    });
    backend.afterWrite = async (writeNumber) => {
      if (writeNumber === 1) await stalled;
    };
    const first = processNextJob(context(), { accountId });
    await vi.waitFor(async () => expect(await usersIn(namespace)).toHaveLength(1), { timeout: 30_000 });
    expect((await row(rowId)).released_at).toBeNull();

    await makeReady(jobId);
    const second = await processNextJob(context(), { accountId });
    expect(second?.outcome).toBe('done');
    expect(second?.job.attempts).toBe(2);

    resume();
    expect((await first)?.outcome).toBe('lease_lost');
    expect(await inStore(namespace, 'SELECT id, name FROM "user"')).toEqual([{ id: 'u1', name: 'Ada' }]);
    expect(await inStore(namespace, 'SELECT sku FROM user_orders')).toEqual([{ sku: 'A' }]);
    expect(await logFor(rowId)).toMatchObject([{ status: 'released' }]);
  });
});

describe('finishing a replay', () => {
  it('runs again from the start, reaching a row it had paged past when the rerun was requested', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const newShape = { id: 'early', name: 'n', nickname: 'x' };
    // Doesn't match yet, and sorts ahead of the row that the first pass writes.
    const early = await addQuarantined(accountId, newShape);
    await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId, 2);
    backend.afterWrite = async () => {
      await db.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        adapterId,
        fingerprint(newShape),
      ]);
      expect(await enqueueReplay(db, adapterId)).toBe(true);
      backend.afterWrite = undefined;
    };

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('rerun');

    expect((await row(early.rowId)).released_at).toBeNull();
    const queued = await jobRow(jobId);
    expect(queued).toMatchObject({ rerun_requested: false, ready: true });
    // A rerun is a fresh replay, so an old job doesn't get less time on its next failure.
    expect(queued?.age_s).toBeLessThan(60);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await jobRow(jobId)).toBeUndefined();
    expect((await row(early.rowId)).released_at).not.toBeNull();
    expect((await usersIn(namespace)).map(({ id }) => id)).toEqual(['a', 'early']);
  });

  it('does not lose a request that arrives just as the replay finishes', async () => {
    const accountId = await newAccount();
    const adapterId = await addAdapter(accountId);
    await addJob(accountId, adapterId);
    const job = await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId });

    await enqueueReplay(db, adapterId);
    expect(await finishReplay(db, job!)).toBe('rerun');

    // Now the job is gone, a request makes a new one.
    const again = await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId });
    expect(await finishReplay(db, again!)).toBe('deleted');
    expect(await enqueueReplay(db, adapterId)).toBe(true);
    const left = await db.query<{ rerun_requested: boolean }>(
      `SELECT rerun_requested FROM queue WHERE adapter_id = $1`,
      [adapterId],
    );
    expect(left.rows).toEqual([{ rerun_requested: false }]);
  });

  it('leaves the job alone if another worker holds it', async () => {
    const accountId = await newAccount();
    const adapterId = await addAdapter(accountId);
    const jobId = await addJob(accountId, adapterId);
    const stale = await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId });
    await makeReady(jobId);
    await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId });
    await enqueueReplay(db, adapterId);

    expect(await finishReplay(db, stale!)).toBe('lease_lost');
    expect(await jobRow(jobId)).toMatchObject({ attempts: 2, rerun_requested: true });
  });

  it('stops at the next page once another worker has taken the job', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    await addQuarantined(accountId, userBody('a'));
    await addQuarantined(accountId, userBody('b'));
    const jobId = await addJob(accountId, adapterId);
    backend.afterWrite = async () => {
      await makeReady(jobId);
      await claimJob(db, { kinds: ['replay'], leaseMs: 60_000, accountId });
    };

    const result = await processNextJob(context({ replayBatchSize: 1 }), { accountId });

    expect(result?.outcome).toBe('lease_lost');
    expect(backend.writes.flatMap(({ ids }) => ids)).toEqual(['a']);
    expect(await jobRow(jobId)).toMatchObject({ attempts: 2 });
  });

  it('keeps its lease through a long replay', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);
    const settings = { leaseMs: 600 };
    let stolen: Awaited<ReturnType<typeof processNextJob>> | undefined;
    backend.beforeWrite = async () => {
      // Twice the lease, so without renewals another worker would claim the job here.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      stolen = await processNextJob(context(settings), { accountId });
    };

    const result = await processNextJob(context(settings), { accountId });

    expect(stolen).toBeNull();
    expect(result?.outcome).toBe('done');
    expect(result?.job.attempts).toBe(1);
    expect(await jobRow(jobId)).toBeUndefined();
  });
});

describe('enqueueReplay', () => {
  it('inserts one job, then asks it to run again', async () => {
    const accountId = await newAccount();
    const adapterId = await addAdapter(accountId);

    expect(await enqueueReplay(db, adapterId)).toBe(true);
    expect(await enqueueReplay(db, adapterId)).toBe(true);

    const jobs = await db.query(
      `SELECT account_id, kind, rerun_requested FROM queue WHERE adapter_id = $1`,
      [adapterId],
    );
    expect(jobs.rows).toEqual([{ account_id: accountId, kind: 'replay', rerun_requested: true }]);
  });

  it('refuses an adapter that is not active', async () => {
    const accountId = await newAccount();
    const adapterId = await addAdapter(accountId, { active: false });

    expect(await enqueueReplay(db, adapterId)).toBe(false);

    const jobs = await db.query('SELECT 1 FROM queue WHERE adapter_id = $1', [adapterId]);
    expect(jobs.rows).toEqual([]);
  });
});

describe('the sweep', () => {
  it('enqueues a replay for a stranded row, which then releases it', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));

    expect(await sweepStrandedRows(context(), { accountId })).toEqual([adapterId]);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    expect((await row(rowId)).released_at).not.toBeNull();
    expect(await usersIn(namespace)).toHaveLength(1);
    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
  });

  it('stops after one failed replay, since that changes the row reason', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('boom'));

    expect(await sweepStrandedRows(context(), { accountId })).toEqual([adapterId]);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await row(rowId)).toMatchObject({ released_at: null, reason: 'adapter_error' });

    for (let tick = 0; tick < 3; tick += 1) {
      expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
      expect(await processNextJob(context(), { accountId })).toBeNull();
    }
    expect(await logFor(rowId)).toHaveLength(1);
  });

  it('ends once the backend returns, however many times it swept during an outage', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    backend.beforeWrite = async () => {
      throw new StorageError('down', { retryable: true });
    };

    await sweepStrandedRows(context(), { accountId });
    const job = await processNextJob(context(), { accountId });
    expect(job?.outcome).toBe('retry');
    await sweepStrandedRows(context(), { accountId });
    await makeReady(job!.job.id);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await logFor(rowId)).toEqual([]);

    backend.beforeWrite = undefined;
    await makeReady(job!.job.id);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
    expect(await processNextJob(context(), { accountId })).toBeNull();
    expect(await logFor(rowId)).toHaveLength(1);
  });

  it('ignores malformed rows, other reasons, inactive adapters, and released rows', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    await addAdapter(accountId);
    await addAdapter(accountId, { shape: { only: 'inactive' }, active: false });
    await addQuarantined(accountId, 'bare string', { reason: 'malformed', malformed: true });
    await addQuarantined(accountId, userBody('a'), { reason: 'malformed' });
    await addQuarantined(accountId, userBody('b'), { reason: 'adapter_error' });
    await addQuarantined(accountId, userBody('c'), { reason: 'write_error' });
    await addQuarantined(accountId, { only: 'x' });
    await addQuarantined(accountId, { nothing: 'matches this' });
    const released = await addQuarantined(accountId, userBody('d'));
    await db.query('UPDATE quarantine SET released_at = now() WHERE id = $1', [released.rowId]);

    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
    const jobs = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [accountId]);
    expect(jobs.rows).toEqual([]);
  });

  it('finds matches through adapter_fingerprints and opaque paths', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const also = { id: 'b', name: 'n', nickname: 'x' };
    const exactId = await addAdapter(accountId, { alsoMatches: [also] });
    const opaqueId = await addAdapter(accountId, { shape: { id: 'x', metadata: { k: 1 } }, opaquePaths: ['metadata'] });
    await addQuarantined(accountId, also);
    await addQuarantined(accountId, { id: 'a', metadata: { other: true } });

    const enqueued = await sweepStrandedRows(context(), { accountId });

    expect(enqueued.sort()).toEqual([exactId, opaqueId].sort());
  });

  it('leaves a queued replay alone, so a long one is not repeated, and catches a missed row afterwards', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const adapterId = await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));
    const jobId = await addJob(accountId, adapterId);

    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);

    expect(await jobRow(jobId)).toMatchObject({ rerun_requested: false });
    const jobs = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [accountId]);
    expect(jobs.rowCount).toBe(1);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect((await row(rowId)).released_at).not.toBeNull();

    // A row that landed behind that replay is picked up now that the job has gone.
    const missed = await addQuarantined(accountId, userBody('b'));
    expect(await sweepStrandedRows(context(), { accountId })).toEqual([adapterId]);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect((await row(missed.rowId)).released_at).not.toBeNull();
  });

  it('only sweeps the requested account', async () => {
    const accountId = await newAccount();
    const other = await newAccount();
    await addAdapter(other);
    await addQuarantined(other, userBody('a'));

    expect(await sweepStrandedRows(context(), { accountId })).toEqual([]);
  });

  it('runs on a timer in the worker', async () => {
    const accountId = await newAccount();
    const { namespace } = await addStore(accountId);
    await addAdapter(accountId);
    const { rowId } = await addQuarantined(accountId, userBody('a'));

    const worker = startWorker({
      databaseUrl: config.appDatabaseUrl,
      decryptCredentials: (encrypted) => JSON.parse(encrypted.toString('utf8')) as Record<string, unknown>,
      backends: { postgres: backend },
      log: () => {},
      pollMs: 20,
      sweepIntervalMs: 50,
      accountId,
    });
    try {
      await vi.waitFor(async () => expect((await row(rowId)).released_at).not.toBeNull(), { timeout: 30_000 });
    } finally {
      await worker.stop();
    }
    expect(await usersIn(namespace)).toHaveLength(1);
    const jobs = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [accountId]);
    expect(jobs.rowCount).toBeLessThanOrEqual(1);
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StorageError, type SchemaChange, type StorageBackend, type StoreConfig, type TableRows } from '../src/contracts/index.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { runAdapter, SandboxUnavailableError } from '../src/sandbox/index.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { DEFAULT_SETTINGS, processNextJob, startWorker, type WorkerContext } from '../src/worker/index.js';
import { findAdapter } from '../src/worker/match.js';
import { backoffMs, claimJob, deleteJob, pushRunAt, quarantineJob, toDetail } from '../src/worker/queue.js';

// Everything but runAdapter is the real module, and runAdapter is real until a test says otherwise.
vi.mock('../src/sandbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/index.js')>();
  return { ...actual, runAdapter: vi.fn(actual.runAdapter) };
});

// Databases and child processes add up, particularly when other test files are busy too.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

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

/** Records calls in order, and fails or waits on request. */
class FakeBackend implements StorageBackend {
  readonly capabilities = { atomicWrites: true, idempotency: 'immediate' } as const;
  calls: { namespace: string; op: 'applySchema' | 'write'; tables?: TableRows[]; changes?: SchemaChange[] }[] = [];
  failWrite: ((store: StoreConfig) => Error | undefined) | undefined;
  duringApplySchema: (() => Promise<void>) | undefined;
  duringWrite: (() => Promise<void>) | undefined;

  async provision(): Promise<Record<string, unknown>> {
    return {};
  }
  async applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void> {
    this.calls.push({ namespace: store.namespace, op: 'applySchema', changes });
    await this.duringApplySchema?.();
  }
  async write(store: StoreConfig, tables: TableRows[]): Promise<void> {
    this.calls.push({ namespace: store.namespace, op: 'write', tables });
    await this.duringWrite?.();
    const failure = this.failWrite?.(store);
    if (failure) throw failure;
  }
  async health(): Promise<void> {}
  written(): string[] {
    return this.calls.filter(({ op }) => op === 'write').map(({ namespace }) => namespace);
  }
}

let fake: FakeBackend;
const log = vi.fn();

function context(settings: Partial<WorkerContext['settings']> = {}): WorkerContext {
  return {
    db,
    backends: { postgres: realBackend, fake },
    // Tests keep credentials as plain JSON, since encryption belongs to account creation.
    decryptCredentials: (encrypted) => JSON.parse(encrypted.toString('utf8')) as Record<string, unknown>,
    settings: { ...DEFAULT_SETTINGS, log, ...settings },
  };
}

const request = { method: 'POST', path: '/ingest', query: '', headers: {} };

async function newAccount(): Promise<string> {
  const id = randomUUID();
  accounts.push(id);
  await db.query('INSERT INTO accounts (id, slug) VALUES ($1, $2)', [id, `worker-${id}`]);
  return id;
}

let generation = 0;

async function addStore(
  accountId: string,
  options: {
    status?: string;
    backend?: string;
    namespace?: string;
    connection?: object;
    credentials?: object;
    generation?: number;
  } = {},
): Promise<{ id: string; namespace: string }> {
  const id = randomUUID();
  const namespace = options.namespace ?? `fake_${id}`;
  await db.query(
    `INSERT INTO account_stores (id, account_id, generation, backend, connection, credentials, namespace, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      accountId,
      options.generation ?? ++generation,
      options.backend ?? 'fake',
      options.connection ?? {},
      options.credentials ? Buffer.from(JSON.stringify(options.credentials)) : null,
      namespace,
      options.status ?? 'active',
    ],
  );
  return { id, namespace };
}

/** A real store, with its own database. */
async function addRealStore(accountId: string): Promise<{ id: string; namespace: string; store: StoreConfig }> {
  const namespace = `t_${randomBytes(6).toString('hex')}_worker`;
  scratchDatabases.push(namespace);
  const store: StoreConfig = { namespace, connection: dataConnection, credentials: dataCredentials };
  await realBackend.provision(store);
  const { id } = await addStore(accountId, {
    backend: 'postgres',
    namespace,
    connection: dataConnection,
    credentials: dataCredentials,
  });
  return { id, namespace, store };
}

async function inStore<T>(namespace: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...dataConnection, ...dataCredentials, database: namespace });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function addAdapter(
  accountId: string,
  options: {
    code: string;
    shape?: unknown;
    fingerprint?: string;
    opaquePaths?: string[];
    source?: string;
    op?: string;
    active?: boolean;
    createdAt?: string;
    version?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const opaquePaths = options.opaquePaths ?? [];
  await db.query(
    `INSERT INTO adapters
       (id, account_id, source, op, fingerprint, opaque_paths, version, code, active, validated_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), COALESCE($10::timestamptz, now()))`,
    [
      id,
      accountId,
      options.source ?? '',
      options.op ?? 'write',
      options.fingerprint ?? fingerprint(options.shape, { opaquePaths }),
      opaquePaths,
      options.version ?? 1,
      options.code,
      options.active ?? true,
      options.createdAt ?? null,
    ],
  );
  return id;
}

async function addEvent(
  accountId: string,
  body: unknown,
  options: { source?: string; op?: string; receivedAt?: string; rawBody?: string; jobAgeHours?: number } = {},
): Promise<{ eventId: string; jobId: string; seq: string }> {
  const raw = options.rawBody ?? JSON.stringify(body);
  const event = await db.query<{ id: string; seq: string }>(
    `INSERT INTO events (account_id, body, source, op, fingerprint, request, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now())) RETURNING id, seq`,
    [
      accountId,
      Buffer.from(raw, 'utf8'),
      options.source ?? '',
      options.op ?? 'write',
      fingerprint(body),
      request,
      options.receivedAt ?? null,
    ],
  );
  const { id: eventId, seq } = event.rows[0]!;
  const job = await db.query<{ id: string }>(
    `INSERT INTO queue (account_id, kind, event_id, created_at)
     VALUES ($1, 'ingest', $2, now() - $3::double precision * interval '1 hour') RETURNING id`,
    [accountId, eventId, options.jobAgeHours ?? 0],
  );
  return { eventId, jobId: job.rows[0]!.id, seq };
}

async function jobRow(jobId: string) {
  const result = await db.query<{ attempts: number; delay_ms: number }>(
    `SELECT attempts, (extract(epoch FROM run_at - now()) * 1000)::double precision AS delay_ms
     FROM queue WHERE id = $1`,
    [jobId],
  );
  return result.rows[0];
}

/** Makes a queued job eligible now, as if its lease or backoff had passed. */
async function makeReady(jobId: string): Promise<void> {
  await db.query(`UPDATE queue SET run_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
}

async function quarantineRows(eventId: string) {
  const result = await db.query<{
    account_id: string;
    store_id: string | null;
    reason: string;
    detail: string;
    released_at: Date | null;
  }>('SELECT account_id, store_id, reason, detail, released_at FROM quarantine WHERE event_id = $1', [eventId]);
  return result.rows;
}

const userAdapter = `function adapt(payload) {
  return { table: 'user', rows: [{ id: payload.data.id, name: payload.data.name }] };
}`;

beforeEach(() => {
  fake = new FakeBackend();
  log.mockClear();
  vi.mocked(runAdapter).mockClear();
});

afterAll(async () => {
  const ids = [accounts];
  await db.query('DELETE FROM queue WHERE account_id = ANY($1)', ids);
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

describe('the real sandbox, planner, and backend together', () => {
  it('writes an event to clean tables, then deletes the job', async () => {
    const accountId = await newAccount();
    const { id: storeId, namespace } = await addRealStore(accountId);
    const body = {
      email: 'ada@example.com',
      profile: { first_name: 'Ada' },
      orders: [{ sku: 'A1', amount: 100 }, { sku: 'A2', amount: 200 }],
    };
    await addAdapter(accountId, {
      shape: body,
      code: `function adapt(payload) {
        const d = payload.data;
        return {
          table: 'user',
          rows: [{
            id: d.email,
            email: d.email,
            first_name: d.profile.first_name,
            children: { orders: { rows: d.orders.map((o) => ({ sku: o.sku, amount: o.amount })) } },
          }],
        };
      }`,
    });
    const { jobId, eventId, seq } = await addEvent(accountId, body);

    const result = await processNextJob(context(), { accountId });

    expect(result?.outcome).toBe('done');
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toEqual([]);

    const { users, orders } = await inStore(namespace, async (client) => ({
      users: (await client.query('SELECT *, _event_seq::text AS seq FROM "user"')).rows,
      orders: (await client.query('SELECT * FROM user_orders ORDER BY sku')).rows,
    }));
    expect(users).toMatchObject([{ id: 'ada@example.com', first_name: 'Ada', seq, _deleted_at: null }]);
    expect(orders).toMatchObject([
      { sku: 'A1', amount: '100', user_id: 'ada@example.com' },
      { sku: 'A2', amount: '200', user_id: 'ada@example.com' },
    ]);

    const registered = await db.query(
      `SELECT column_name FROM data_columns WHERE store_id = $1 AND table_name = 'user_orders'`,
      [storeId],
    );
    expect(registered.rows.map((row: { column_name: string }) => row.column_name).sort()).toEqual([
      'amount',
      'id',
      'sku',
      'user_id',
    ]);
  });

  it('recovers from a crash between the write and the delete, without duplicating anything', async () => {
    const accountId = await newAccount();
    const { namespace } = await addRealStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId } = await addEvent(accountId, body);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    // What a worker leaves behind if it dies after writing: the job, with its lease expired.
    await db.query(
      `INSERT INTO queue (account_id, kind, event_id, attempts, run_at)
       VALUES ($1, 'ingest', $2, 1, now() - interval '1 second')`,
      [accountId, eventId],
    );
    const result = await processNextJob(context(), { accountId });

    expect(result?.outcome).toBe('done');
    expect(result?.job.attempts).toBe(2);
    const rows = await inStore(namespace, async (client) => (await client.query('SELECT id, name FROM "user"')).rows);
    expect(rows).toEqual([{ id: 'u1', name: 'Ada' }]);
    expect(await quarantineRows(eventId)).toEqual([]);
  });

  it('recovers from a crash right after the claim, once the lease expires', async () => {
    const accountId = await newAccount();
    const { namespace } = await addRealStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { jobId } = await addEvent(accountId, body);

    expect(await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId })).not.toBeNull();
    expect(await processNextJob(context(), { accountId })).toBeNull();

    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    const rows = await inStore(namespace, async (client) => (await client.query('SELECT id FROM "user"')).rows);
    expect(rows).toEqual([{ id: 'u1' }]);
  });

  it('marks a delete with the exact received_at, down to the microsecond', async () => {
    const accountId = await newAccount();
    const { namespace } = await addRealStore(accountId);
    const body = { id: 'u1' };
    await addAdapter(accountId, {
      shape: body,
      op: 'delete',
      code: `function adapt(payload) { return { table: 'user', rows: [{ id: payload.data.id, _deleted: true }] }; }`,
    });
    await addEvent(accountId, body, { op: 'delete', receivedAt: '2026-11-07T12:00:00.123456Z' });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    const rows = await inStore(namespace, async (client) =>
      (await client.query(
        `SELECT to_char(_deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted FROM "user"`,
      )).rows,
    );
    expect(rows).toEqual([{ deleted: '2026-11-07T12:00:00.123456Z' }]);
  });

  it('sends events with different keys under an opaque path to one adapter, as json', async () => {
    const accountId = await newAccount();
    const { namespace } = await addRealStore(accountId);
    await addAdapter(accountId, {
      shape: { id: 'x', metadata: { first: 1 } },
      opaquePaths: ['metadata'],
      code: `function adapt(payload) {
        return { table: 'item', rows: [{ id: payload.data.id, metadata: payload.data.metadata }] };
      }`,
    });
    await addEvent(accountId, { id: 'a', metadata: { first: 1 } });
    await addEvent(accountId, { id: 'b', metadata: { other: { nested: true } } });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');

    const rows = await inStore(namespace, async (client) => (await client.query('SELECT id, metadata FROM item ORDER BY id')).rows);
    expect(rows).toEqual([
      { id: 'a', metadata: { first: 1 } },
      { id: 'b', metadata: { other: { nested: true } } },
    ]);
  });

  it('quarantines a type that conflicts with the registered column, against that store', async () => {
    const accountId = await newAccount();
    const { id: storeId, namespace } = await addRealStore(accountId);
    const code = `function adapt(payload) { return { table: 'item', rows: [{ id: payload.data.id, value: payload.data.value }] }; }`;
    await addAdapter(accountId, { shape: { id: 'x', value: 1 }, code });
    await addAdapter(accountId, { shape: { id: 'x', value: 'y' }, code });
    await addEvent(accountId, { id: 'a', value: 1 });
    const second = await addEvent(accountId, { id: 'b', value: 'text' });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(await quarantineRows(second.eventId)).toMatchObject([
      { account_id: accountId, store_id: storeId, reason: 'schema_conflict', detail: expect.stringContaining('item.value') },
    ]);
    expect(await jobRow(second.jobId)).toBeUndefined();
    const rows = await inStore(namespace, async (client) => (await client.query('SELECT id FROM item')).rows);
    expect(rows).toEqual([{ id: 'a' }]);
  });

  it('quarantines a write the backend permanently rejects, such as a NUL byte', async () => {
    const accountId = await newAccount();
    const { id: storeId } = await addRealStore(accountId);
    const body = { id: 'u1' };
    await addAdapter(accountId, {
      shape: body,
      code: `function adapt() { return { table: 'item', rows: [{ id: 'a', name: 'bad\\u0000value' }] }; }`,
    });
    const { eventId, jobId } = await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: storeId, reason: 'write_error' }]);
    expect(await jobRow(jobId)).toBeUndefined();
  });

  it('quarantines when the store database does not exist', async () => {
    const accountId = await newAccount();
    const { id: storeId } = await addStore(accountId, {
      backend: 'postgres',
      namespace: `t_${randomBytes(6).toString('hex')}_missing`,
      connection: dataConnection,
      credentials: dataCredentials,
    });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId } = await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: storeId, reason: 'write_error' }]);
  });

  it('keeps the job through a real backend outage, then writes when it returns', async () => {
    const accountId = await newAccount();
    const { id: storeId, namespace } = await addRealStore(accountId);
    // Nothing listens on this port, so connections are refused the way they are in an outage.
    await db.query('UPDATE account_stores SET connection = $2 WHERE id = $1', [
      storeId,
      { ...dataConnection, port: 1 },
    ]);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId, jobId } = await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await quarantineRows(eventId)).toEqual([]);
    const row = await jobRow(jobId);
    expect(row?.attempts).toBe(1);
    expect(row?.delay_ms).toBeGreaterThan(0);
    expect(row?.delay_ms).toBeLessThanOrEqual(DEFAULT_SETTINGS.backoffBaseMs);

    await db.query('UPDATE account_stores SET connection = $2 WHERE id = $1', [storeId, dataConnection]);
    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    const rows = await inStore(namespace, async (client) => (await client.query('SELECT id FROM "user"')).rows);
    expect(rows).toEqual([{ id: 'u1' }]);
  });
});

describe('quarantining a job', () => {
  it('quarantines an unknown shape under the same account, and deletes the job', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const { eventId, jobId } = await addEvent(accountId, { never: 'seen' });

    const result = await processNextJob(context(), { accountId });

    expect(result?.outcome).toBe('quarantined');
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([
      { account_id: accountId, store_id: null, reason: 'unknown_fingerprint', released_at: null },
    ]);
    expect(runAdapter).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('keeps the job and every row if any quarantine insert fails, since they share a transaction', async () => {
    const accountId = await newAccount();
    const { eventId, jobId } = await addEvent(accountId, { never: 'seen' });
    const job = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });

    await expect(
      quarantineJob(db, job!, eventId, [
        { storeId: null, reason: 'unknown_fingerprint', detail: 'fine' },
        // Breaks the reason CHECK, so this one insert fails after the delete and the first insert.
        { storeId: randomUUID(), reason: 'not_a_reason' as 'write_error', detail: 'fails' },
      ]),
    ).rejects.toThrow();

    expect((await jobRow(jobId))?.attempts).toBe(1);
    expect(await quarantineRows(eventId)).toEqual([]);
  });

  it('keeps the job if the connection is lost partway through, instead of crashing', async () => {
    const accountId = await newAccount();
    const { eventId, jobId } = await addEvent(accountId, { never: 'seen' });
    const job = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });

    const lossy = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 1 });
    lossy.on('error', () => {});
    // Loses the connection just after BEGIN, while it sits idle with no query to reject.
    lossy.on('acquire', (client) => {
      const query = client.query.bind(client) as (text: string) => Promise<unknown>;
      let lost = false;
      (client as unknown as { query: unknown }).query = async (...args: [string]) => {
        const result = await query(...args);
        if (!lost) {
          lost = true;
          const { processID } = client as unknown as { processID: number };
          await db.query('SELECT pg_terminate_backend($1)', [processID]);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return result;
      };
    });

    try {
      await expect(
        quarantineJob(lossy, job!, eventId, [{ storeId: null, reason: 'unknown_fingerprint', detail: 'x' }]),
      ).rejects.toThrow();
      expect((await jobRow(jobId))?.attempts).toBe(1);
      expect(await quarantineRows(eventId)).toEqual([]);
      expect(lossy.totalCount).toBe(0);
    } finally {
      await lossy.end();
    }
  });

  it.each([
    ['throws', `function adapt() { throw new Error('boom'); }`, 'threw'],
    ['times out', `function adapt() { for (;;) {} }`, 'timeout'],
    ['has a syntax error', `function adapt( {`, 'syntax_error'],
    ['returns an invalid table name', `function adapt() { return { table: 'Bad-Name', rows: [{ id: 'a' }] }; }`, 'Bad-Name'],
    ['returns an object where a column belongs', `function adapt() { return { table: 't', rows: [{ id: 'a', c: {} }] }; }`, 'opaque path'],
  ])('quarantines an adapter that %s as adapter_error', async (_name, code, expected) => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1' };
    await addAdapter(accountId, { shape: body, code });
    const { eventId, jobId } = await addEvent(accountId, body);

    const result = await processNextJob(context({ sandboxLimits: { timeoutMs: 100 } }), { accountId });

    expect(result?.outcome).toBe('quarantined');
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([
      { account_id: accountId, store_id: null, reason: 'adapter_error', detail: expect.stringContaining(expected) },
    ]);
    expect(fake.calls).toEqual([]);
  });

  it('quarantines an adapter whose error message holds a NUL byte, rather than failing on it', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1' };
    await addAdapter(accountId, { shape: body, code: `function adapt() { throw new Error('a\\u0000b'); }` });
    const { eventId } = await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');
    expect((await quarantineRows(eventId))[0]?.detail).toContain('a�b');
  });

  it('quarantines a conflict within one event before any store is touched', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1' };
    await addAdapter(accountId, {
      shape: body,
      code: `function adapt() { return { table: 't', rows: [{ id: 'a', x: 1 }, { id: 'b', x: 'y' }] }; }`,
    });
    const { eventId } = await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: null, reason: 'schema_conflict' }]);
    expect(fake.calls).toEqual([]);
  });
});

describe('transient failures', () => {
  async function setUp() {
    const accountId = await newAccount();
    const store = await addStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    return { accountId, store, body };
  }

  it('retries a retryable StorageError', async () => {
    const { accountId, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body);
    fake.failWrite = () => new StorageError('down', { retryable: true });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await quarantineRows(eventId)).toEqual([]);
    expect((await jobRow(jobId))?.attempts).toBe(1);
  });

  it('retries any error from the backend that is not a StorageError', async () => {
    const { accountId, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body);
    fake.failWrite = () => new TypeError('a bug in the backend');

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await quarantineRows(eventId)).toEqual([]);
    expect(await jobRow(jobId)).toBeDefined();
  });

  it('retries when applySchema fails', async () => {
    const { accountId, body } = await setUp();
    await addEvent(accountId, body);
    fake.duringApplySchema = async () => {
      throw new StorageError('down', { retryable: true });
    };

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(fake.written()).toEqual([]);
  });

  it('retries when the sandbox itself is unavailable', async () => {
    const { accountId, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body);
    vi.mocked(runAdapter).mockRejectedValueOnce(new SandboxUnavailableError('no process'));

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await quarantineRows(eventId)).toEqual([]);

    await makeReady(jobId);
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
  });

  it('retries when the account has no live store', async () => {
    const accountId = await newAccount();
    await addStore(accountId, { status: 'retired' });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
  });

  it('retries when this worker has no such backend', async () => {
    const accountId = await newAccount();
    await addStore(accountId, { backend: 'clickhouse' });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
  });

  it('backs off exponentially up to the cap', async () => {
    expect([1, 2, 3, 4].map((attempt) => backoffMs(attempt, 5, 30))).toEqual([5, 10, 20, 30]);
    expect(backoffMs(100_000, 5, 30)).toBe(30);

    const { accountId, body } = await setUp();
    const { jobId } = await addEvent(accountId, body);
    fake.failWrite = () => new StorageError('down', { retryable: true });
    const settings = { backoffBaseMs: 60_000, backoffMaxMs: 150_000 };

    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await processNextJob(context(settings), { accountId });
      delays.push((await jobRow(jobId))!.delay_ms);
      await makeReady(jobId);
    }
    expect(delays[0]).toBeGreaterThan(50_000);
    expect(delays[0]).toBeLessThanOrEqual(60_000);
    expect(delays[1]).toBeGreaterThan(110_000);
    expect(delays[1]).toBeLessThanOrEqual(120_000);
    expect(delays[2]).toBeGreaterThan(140_000);
    expect(delays[2]).toBeLessThanOrEqual(150_000);
  });

  it('moves the event to write_error once it reaches the maximum age', async () => {
    const { accountId, store, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body, { jobAgeHours: 73 });
    fake.failWrite = () => new StorageError('still down', { retryable: true });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([
      { account_id: accountId, store_id: store.id, reason: 'write_error', detail: expect.stringContaining('still down') },
    ]);
  });

  it('still retries just inside the maximum age', async () => {
    const { accountId, body } = await setUp();
    await addEvent(accountId, body, { jobAgeHours: 71 });
    fake.failWrite = () => new StorageError('down', { retryable: true });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
  });

  it('makes a final attempt when a job that has been retrying passes the maximum age', async () => {
    const { accountId, store, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body, { jobAgeHours: 71 });
    fake.failWrite = () => new StorageError('down', { retryable: true });
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');

    // Late enough that workers were stopped for a while, such as a 30-minute deploy.
    await db.query(`UPDATE queue SET created_at = now() - interval '72 hours 30 minutes' WHERE id = $1`, [jobId]);
    await makeReady(jobId);
    fake.calls = [];
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(fake.written()).toEqual([store.namespace]);
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: store.id, reason: 'write_error' }]);
  });

  it('writes a job that recovers on its final attempt', async () => {
    const { accountId, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body);
    await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    await db.query(`UPDATE queue SET created_at = now() - interval '72 hours 1 minute' WHERE id = $1`, [jobId]);
    await makeReady(jobId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await quarantineRows(eventId)).toEqual([]);
  });

  it('honours a configured maximum age', async () => {
    const { accountId, body } = await setUp();
    await addEvent(accountId, body, { jobAgeHours: 2 });
    fake.failWrite = () => new StorageError('down', { retryable: true });

    const result = await processNextJob(context({ maxAgeMs: 60 * 60 * 1000 }), { accountId });
    expect(result?.outcome).toBe('quarantined');
  });

  it('writes an old job that was simply waiting, since nothing has failed yet', async () => {
    const { accountId, body } = await setUp();
    const { eventId } = await addEvent(accountId, body, { jobAgeHours: 73 });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(await quarantineRows(eventId)).toEqual([]);
  });

  it('gives up well past the maximum age on a job with earlier attempts, in case the event kills workers', async () => {
    const { accountId, body } = await setUp();
    const { eventId, jobId } = await addEvent(accountId, body, { jobAgeHours: 74 });
    await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    await makeReady(jobId);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(fake.calls).toEqual([]);
    expect(await quarantineRows(eventId)).toMatchObject([
      { store_id: null, reason: 'write_error', detail: expect.stringContaining('Given up') },
    ]);
  });
});

describe('live stores', () => {
  it('writes to live stores with the active store first, and never to a retired one', async () => {
    const accountId = await newAccount();
    await addStore(accountId, { status: 'retired', namespace: 'retired', generation: 1 });
    await addStore(accountId, { status: 'building', namespace: 'building', generation: 2 });
    await addStore(accountId, { status: 'ready', namespace: 'ready', generation: 3 });
    await addStore(accountId, { status: 'active', namespace: 'active', generation: 4 });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    await addEvent(accountId, body);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    expect(fake.written()).toEqual(['active', 'building', 'ready']);
    expect(fake.calls[0]).toMatchObject({ namespace: 'active', op: 'applySchema' });
  });

  it('keeps the active store current while the new one is down, and records write_error only against it', async () => {
    const accountId = await newAccount();
    await addStore(accountId, { status: 'active', namespace: 'active' });
    const building = await addStore(accountId, { status: 'building', namespace: 'building' });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId, jobId } = await addEvent(accountId, body);
    fake.failWrite = ({ namespace }) =>
      namespace === 'building' ? new StorageError('down', { retryable: true }) : undefined;

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(fake.written()).toEqual(['active', 'building']);
    expect(await quarantineRows(eventId)).toEqual([]);

    await db.query(`UPDATE queue SET created_at = now() - interval '72 hours 1 minute' WHERE id = $1`, [jobId]);
    await makeReady(jobId);
    fake.calls = [];
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(fake.written()).toEqual(['active', 'building']);
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: building.id, reason: 'write_error' }]);
  });

  it('quarantines against the store that permanently failed, and still writes the others', async () => {
    const accountId = await newAccount();
    const active = await addStore(accountId, { status: 'active', namespace: 'active' });
    await addStore(accountId, { status: 'building', namespace: 'building' });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId, jobId } = await addEvent(accountId, body);
    fake.failWrite = ({ namespace }) =>
      namespace === 'active' ? new StorageError('rejected', { retryable: false }) : undefined;

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');

    expect(fake.written()).toEqual(['active', 'building']);
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: active.id, reason: 'write_error' }]);
  });

  it('quarantines a permanent failure at once, even while another store is still retrying', async () => {
    const accountId = await newAccount();
    const active = await addStore(accountId, { status: 'active', namespace: 'active' });
    await addStore(accountId, { status: 'building', namespace: 'building' });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { eventId, jobId } = await addEvent(accountId, body);
    fake.failWrite = ({ namespace }) =>
      namespace === 'active'
        ? new StorageError('rejected', { retryable: false })
        : new StorageError('down', { retryable: true });

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('retry');
    expect(await quarantineRows(eventId)).toMatchObject([{ store_id: active.id, reason: 'write_error' }]);
    const row = await jobRow(jobId);
    expect(row?.attempts).toBe(1);
    expect(row?.delay_ms).toBeLessThanOrEqual(DEFAULT_SETTINGS.backoffBaseMs);

    // The repeat reuses the open row, and the job finishes once the other store recovers.
    await makeReady(jobId);
    fake.failWrite = ({ namespace }) =>
      namespace === 'active' ? new StorageError('rejected again', { retryable: false }) : undefined;
    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('quarantined');
    expect(await jobRow(jobId)).toBeUndefined();
    expect(await quarantineRows(eventId)).toMatchObject([
      { store_id: active.id, reason: 'write_error', detail: expect.stringContaining('rejected again') },
    ]);
  });

  it('passes decrypted credentials to the backend', async () => {
    const accountId = await newAccount();
    await addStore(accountId, { credentials: { user: 'u', password: 'p' } });
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    await addEvent(accountId, body);
    const write = vi.spyOn(fake, 'write');

    await processNextJob(context(), { accountId });

    expect(write.mock.calls[0]?.[0].credentials).toEqual({ user: 'u', password: 'p' });
  });
});

describe('claiming', () => {
  it('skips rows another worker has locked', async () => {
    const accountId = await newAccount();
    const first = await addEvent(accountId, { n: 1 });
    await addEvent(accountId, { n: 2 });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM queue WHERE id = $1 FOR UPDATE', [first.jobId]);
      const claimed = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
      expect(claimed).not.toBeNull();
      expect(claimed?.id).not.toBe(first.jobId);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('never hands one job to two concurrent workers', async () => {
    const accountId = await newAccount();
    const jobs = await Promise.all(Array.from({ length: 5 }, (_, n) => addEvent(accountId, { n })));

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId })),
    );

    const claimed = claims.flatMap((job) => (job ? [job.id] : []));
    expect(claimed.length).toBe(5);
    expect(new Set(claimed)).toEqual(new Set(jobs.map(({ jobId }) => jobId)));
  });

  it('advances run_at and attempts in the claim, and a job returns when its lease expires', async () => {
    const accountId = await newAccount();
    const { jobId } = await addEvent(accountId, { n: 1 });

    const claim = () => claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    expect((await claim())?.attempts).toBe(1);
    const row = await jobRow(jobId);
    expect(row?.delay_ms).toBeGreaterThan(50_000);

    expect(await claim()).toBeNull();

    await makeReady(jobId);
    expect((await claim())?.attempts).toBe(2);
  });

  it('leaves replay and rebuild jobs unclaimed', async () => {
    const accountId = await newAccount();
    const { id: storeId } = await addStore(accountId);
    const adapterId = await addAdapter(accountId, { fingerprint: 'f', code: userAdapter });
    await db.query(`INSERT INTO queue (account_id, kind, adapter_id) VALUES ($1, 'replay', $2)`, [accountId, adapterId]);
    await db.query(`INSERT INTO queue (account_id, kind, store_id) VALUES ($1, 'rebuild', $2)`, [accountId, storeId]);

    expect(await processNextJob(context(), { accountId })).toBeNull();

    const rows = await db.query<{ attempts: number }>('SELECT attempts FROM queue WHERE account_id = $1', [accountId]);
    expect(rows.rows).toEqual([{ attempts: 0 }, { attempts: 0 }]);
  });

  it('only claims the requested account', async () => {
    const accountId = await newAccount();
    const other = await newAccount();
    await addEvent(other, { n: 1 });

    expect(await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId })).toBeNull();
  });
});

describe('leases', () => {
  async function setUp() {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const event = await addEvent(accountId, body);
    return { accountId, ...event };
  }

  it('keeps the lease alive through a slow schema change, so no other worker starts the job', async () => {
    const { accountId } = await setUp();
    const leaseMs = 1000;
    let sawClaim: unknown = 'not checked';
    fake.duringApplySchema = async () => {
      // Well beyond the lease. Without a heartbeat, the job would be up for grabs by now.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      sawClaim = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    };

    const result = await processNextJob(context({ leaseMs }), { accountId });

    expect(sawClaim).toBeNull();
    expect(result?.outcome).toBe('done');
  });

  it('holds no lock on the job during backend writes', async () => {
    const { accountId, jobId } = await setUp();
    let locked: unknown;
    fake.duringWrite = async () => {
      locked = await db
        .query('SELECT 1 FROM queue WHERE id = $1 FOR UPDATE NOWAIT', [jobId])
        .then(() => false)
        .catch((error: { code?: string }) => error.code);
    };

    await processNextJob(context(), { accountId });

    expect(locked).toBe(false);
  });

  it('holds no lock on the job during adapter runs', async () => {
    const { accountId, jobId } = await setUp();
    let locked: unknown;
    const actual = (await vi.importActual<typeof import('../src/sandbox/index.js')>('../src/sandbox/index.js')).runAdapter;
    vi.mocked(runAdapter).mockImplementationOnce(async (run, limits) => {
      locked = await db
        .query('SELECT 1 FROM queue WHERE id = $1 FOR UPDATE NOWAIT', [jobId])
        .then(() => false)
        .catch((error: { code?: string }) => error.code);
      return actual(run, limits);
    });

    await processNextJob(context(), { accountId });

    expect(locked).toBe(false);
  });

  it('stops a stalled worker from finishing a job another worker has claimed', async () => {
    const { accountId, jobId, eventId } = await setUp();
    const stale = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    await makeReady(jobId);
    const current = await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });

    expect(await deleteJob(db, stale!)).toBe(false);
    expect(await pushRunAt(db, stale!, 1)).toBe(false);
    expect(
      await quarantineJob(db, stale!, eventId, [{ storeId: null, reason: 'unknown_fingerprint', detail: 'stale' }]),
    ).toBe(false);

    expect(await quarantineRows(eventId)).toEqual([]);
    expect((await jobRow(jobId))?.attempts).toBe(2);
    expect(await deleteJob(db, current!)).toBe(true);
  });

  it('reports a lost lease, and leaves the job to the worker that holds it', async () => {
    const { accountId, jobId } = await setUp();
    fake.duringWrite = async () => {
      await makeReady(jobId);
      await claimJob(db, { kinds: ['ingest'], leaseMs: 60_000, accountId });
    };

    const result = await processNextJob(context(), { accountId });

    expect(result?.outcome).toBe('lease_lost');
    expect((await jobRow(jobId))?.attempts).toBe(2);
  });
});

describe('matching adapters', () => {
  const body = { id: 'x', metadata: { k: 1 } };
  const code = 'function adapt() { return []; }';
  const match = (accountId: string, overrides: Partial<{ source: string; op: string; body: unknown }> = {}) => {
    const value = overrides.body ?? body;
    return findAdapter(db, {
      accountId,
      source: overrides.source ?? '',
      op: overrides.op ?? 'write',
      fingerprint: fingerprint(value),
      body: JSON.stringify(value),
    });
  };

  it('matches on account, source, op, and fingerprint, and only when active', async () => {
    const accountId = await newAccount();
    const other = await newAccount();
    await addAdapter(other, { shape: body, code });
    await addAdapter(accountId, { shape: body, code, source: 'orders' });
    await addAdapter(accountId, { shape: body, code, op: 'delete' });
    await addAdapter(accountId, { shape: body, code, active: false });
    await addAdapter(accountId, { shape: { different: 1 }, code });

    expect(await match(accountId)).toBeNull();

    const wanted = await addAdapter(accountId, { shape: body, code, version: 2 });
    expect((await match(accountId))?.id).toBe(wanted);
  });

  it('matches a fingerprint the adapter has been validated against', async () => {
    const accountId = await newAccount();
    const adapter = await addAdapter(accountId, { shape: { other: 1 }, code });
    await db.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [
      adapter,
      fingerprint(body),
    ]);
    expect((await match(accountId))?.id).toBe(adapter);

    await db.query('UPDATE adapters SET active = false WHERE id = $1', [adapter]);
    expect(await match(accountId)).toBeNull();
  });

  it('prefers an adapter written for the fingerprint over one validated against it', async () => {
    const accountId = await newAccount();
    const validated = await addAdapter(accountId, { shape: { other: 1 }, code, createdAt: '2030-01-01T00:00:00Z' });
    await db.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [
      validated,
      fingerprint(body),
    ]);
    const own = await addAdapter(accountId, { shape: body, code });

    expect((await match(accountId))?.id).toBe(own);
  });

  it('matches through opaque paths, and an exact match takes priority', async () => {
    const accountId = await newAccount();
    const opaque = await addAdapter(accountId, { shape: body, opaquePaths: ['metadata'], code });
    expect((await match(accountId, { body: { id: 'y', metadata: { other: 'key' } } }))?.id).toBe(opaque);
    expect((await match(accountId, { body: { id: 'y', metadata: 'scalar' } }))?.id).toBe(opaque);
    expect(await match(accountId, { body: { id: 'y' } })).toBeNull();

    const exact = await addAdapter(accountId, { shape: body, code });
    expect((await match(accountId))?.id).toBe(exact);
    expect((await match(accountId, { body: { id: 'y', metadata: { other: 'key' } } }))?.id).toBe(opaque);
  });

  it('breaks an opaque tie by fewest paths, then newest', async () => {
    const accountId = await newAccount();
    const eventBody = { id: 'y', a: { z: 1 }, b: { q: 'r' } };
    const add = (opaquePaths: string[], createdAt: string) =>
      addAdapter(accountId, {
        fingerprint: fingerprint(eventBody, { opaquePaths }),
        opaquePaths,
        code,
        createdAt,
      });

    const both = await add(['a', 'b'], '2030-01-01T00:00:00Z');
    expect((await match(accountId, { body: eventBody }))?.id).toBe(both);

    // Fewer paths beats newer. `b` is added before `a`, so insertion order can't be what picks the winner.
    const onlyB = await add(['b'], '2028-01-01T00:00:00Z');
    expect((await match(accountId, { body: eventBody }))?.id).toBe(onlyB);
    await add(['a'], '2026-01-01T00:00:00Z');
    expect((await match(accountId, { body: eventBody }))?.id).toBe(onlyB);
  });

  it('ignores an adapter with a bad opaque path, rather than failing every event', async () => {
    const accountId = await newAccount();
    await addAdapter(accountId, { fingerprint: 'bad', opaquePaths: ['a..b'], code });
    const good = await addAdapter(accountId, { shape: body, opaquePaths: ['metadata'], code });

    expect((await match(accountId))?.id).toBe(good);
  });

  it('matches nothing through opaque paths when the body cannot be parsed', async () => {
    const accountId = await newAccount();
    await addAdapter(accountId, { shape: body, opaquePaths: ['metadata'], code });
    const result = await findAdapter(db, { accountId, source: '', op: 'write', fingerprint: 'x', body: '{nope' });
    expect(result).toBeNull();
  });

  it('treats an empty body as the null shape', async () => {
    const accountId = await newAccount();
    const adapter = await addAdapter(accountId, { shape: null, code, op: 'delete' });
    const result = await findAdapter(db, {
      accountId,
      source: '',
      op: 'delete',
      fingerprint: fingerprint(undefined),
      body: '',
    });
    expect(result?.id).toBe(adapter);
  });

  it('runs the matched opaque adapter with its declared paths, end to end', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    await addAdapter(accountId, {
      shape: body,
      opaquePaths: ['metadata'],
      code: `function adapt(p) { return { table: 't', rows: [{ id: p.data.id, metadata: p.data.metadata }] }; }`,
    });
    const event = { id: 'y', metadata: { any: { thing: 1 } } };
    await addEvent(accountId, event);

    expect((await processNextJob(context(), { accountId }))?.outcome).toBe('done');
    const write = fake.calls.find(({ op }) => op === 'write');
    expect(write?.tables?.[0]).toMatchObject({
      columns: { metadata: 'json' },
      rows: [{ id: 'y', metadata: { any: { thing: 1 } } }],
    });
  });
});

describe('startWorker', () => {
  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('Timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const options = () => ({
    databaseUrl: config.appDatabaseUrl,
    decryptCredentials: () => ({}),
    log,
    pollMs: 20,
    backends: { fake },
  });

  it('works through the queue, then stops cleanly when asked twice', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const jobs = await Promise.all(
      Array.from({ length: 5 }, (_, n) => addEvent(accountId, { id: `u${n}`, name: 'Ada' })),
    );

    const worker = startWorker({ ...options(), concurrency: 2, accountId });
    await waitFor(async () => {
      const left = await db.query('SELECT 1 FROM queue WHERE id = ANY($1)', [jobs.map(({ jobId }) => jobId)]);
      return left.rowCount === 0;
    });
    await Promise.all([worker.stop(), worker.stop()]);

    expect(fake.written().length).toBe(5);
  });

  it('claims nothing after stopping', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const worker = startWorker({ ...options(), accountId });
    await worker.stop();

    const { jobId } = await addEvent(accountId, { id: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect((await jobRow(jobId))?.attempts).toBe(0);
  });

  it('lets a running job finish when stopped', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });
    const { jobId } = await addEvent(accountId, body);
    let startedWrite = false;
    fake.duringWrite = async () => {
      startedWrite = true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    };

    const worker = startWorker({ ...options(), accountId });
    await waitFor(async () => startedWrite);
    await worker.stop();

    expect(await jobRow(jobId)).toBeUndefined();
  });

  it('keeps polling after the application database fails a claim', async () => {
    const accountId = await newAccount();
    await addStore(accountId);
    const body = { id: 'u1', name: 'Ada' };
    await addAdapter(accountId, { shape: body, code: userAdapter });

    // A claim on a bad URL fails, and the worker logs it and stops cleanly rather than crashing.
    const worker = startWorker({
      ...options(),
      databaseUrl: 'postgres://nobody:nothing@localhost:1/nothing',
      accountId,
    });
    await waitFor(async () => log.mock.calls.length > 0);
    await worker.stop();

    expect(log.mock.calls[0]?.[0]).toContain('Could not finish a job');
  });
});

describe('toDetail', () => {
  it('replaces NUL bytes and limits the length', () => {
    expect(toDetail('a\u0000b')).toBe('a�b');
    expect(toDetail('x'.repeat(5000)).length).toBe(2000);
  });
});

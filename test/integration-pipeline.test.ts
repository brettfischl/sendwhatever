// The whole pipeline with no fakes: an account made by the real route, an event row, the real worker,
// sandbox, planner, registry and backend, and the customer's read-only login reading the result.
//
// Most events and adapters are inserted directly, to control the exact bytes. The end of this file sends
// real HTTP to /ingest instead, with the Shopify fixtures and the demo's own clients.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRawIngestClient } from '../demo/console.js';
import { createIngestClient, RequestLog } from '../demo/ingest-client.js';
import { freshDelivery, orderFlow, productFlow, shopifyFlows, type AnyShopifyStep } from '../demo/shopify/index.js';
import { startStub, type Stub } from '../demo/stub.js';
import { loadConfig } from '../src/config.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { createApp } from '../src/http/app.js';
import { decryptJson } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { DEFAULT_SETTINGS, processNextJob, startWorker, type WorkerContext } from '../src/worker/index.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const config = loadConfig();
const db = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 12 });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb: db, backend, config });
const decryptCredentials = (encrypted: Buffer) => decryptJson(config.encryptionKey, encrypted);

const context = (overrides: Partial<WorkerContext['settings']> = {}): WorkerContext => ({
  db,
  backends: { postgres: backend },
  decryptCredentials,
  // A loaded machine can take seconds to start an isolate, and these tests aren't about the limit.
  settings: { ...DEFAULT_SETTINGS, log: () => {}, sandboxLimits: { timeoutMs: 20_000 }, ...overrides },
});

interface Account {
  id: string;
  slug: string;
  apiKey: string;
  storeId: string;
  /** The login the route returned to the customer. */
  login: { host: string; port: number; database: string; user: string; password: string };
  reader: pg.Pool;
}

const accounts: Account[] = [];

async function newAccount(): Promise<Account> {
  const slug = `pipeline-${randomBytes(5).toString('hex')}`;
  const response = await app.request('/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    account_id: string;
    api_key: string;
    database: Account['login'];
  };
  const store = await db.query<{ id: string }>('SELECT id FROM account_stores WHERE account_id = $1', [
    body.account_id,
  ]);
  const reader = new pg.Pool({ ...body.database, max: 2, idleTimeoutMillis: 50 });
  reader.on('error', () => {});
  const account = {
    id: body.account_id,
    slug,
    apiKey: body.api_key,
    storeId: store.rows[0]!.id,
    login: body.database,
    reader,
  };
  accounts.push(account);
  return account;
}

async function addAdapter(
  account: Account,
  body: unknown,
  code: string,
  options: { source?: string; op?: 'write' | 'delete'; opaquePaths?: string[]; version?: number } = {},
): Promise<string> {
  const { source = '', op = 'write', opaquePaths = [], version = 1 } = options;
  const result = await db.query<{ id: string }>(
    `INSERT INTO adapters (account_id, source, op, fingerprint, opaque_paths, version, code, active, validated_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, true, now()) RETURNING id`,
    [account.id, source, op, fingerprint(body, { opaquePaths }), opaquePaths, version, code],
  );
  return result.rows[0]!.id;
}

/** Inserts an event and its job, as /ingest will. `raw` lets a test control the exact bytes. */
async function addEvent(
  account: Account,
  body: unknown,
  options: { source?: string; op?: 'write' | 'delete'; raw?: string; path?: string; query?: string; headers?: Record<string, string> } = {},
): Promise<string> {
  const { source = '', op = 'write', path = source ? `/ingest/${source}` : '/ingest', query = '', headers = {} } = options;
  const text = options.raw ?? (body === undefined ? '' : JSON.stringify(body));
  const request = { method: op === 'delete' ? 'DELETE' : 'POST', path, query, headers };
  const event = await db.query<{ id: string }>(
    `INSERT INTO events (account_id, body, source, op, fingerprint, request)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [account.id, Buffer.from(text), source, op, fingerprint(text === '' ? undefined : JSON.parse(text)), request],
  );
  const id = event.rows[0]!.id;
  await db.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [account.id, id]);
  return id;
}

async function runJobs(account: Account, overrides: Partial<WorkerContext['settings']> = {}): Promise<string[]> {
  const outcomes: string[] = [];
  for (;;) {
    const processed = await processNextJob(context(overrides), { accountId: account.id });
    if (!processed) return outcomes;
    outcomes.push(processed.outcome);
  }
}

/** Rows as the customer's own login sees them. */
async function read<T extends pg.QueryResultRow = Record<string, any>>(
  account: Account,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await account.reader.query<T>(sql, values)).rows;
}

async function openQuarantine(account: Account): Promise<{ reason: string; detail: string; event_id: string }[]> {
  const result = await db.query<{ reason: string; detail: string; event_id: string }>(
    'SELECT reason, detail, event_id FROM quarantine WHERE account_id = $1 AND released_at IS NULL',
    [account.id],
  );
  return result.rows;
}

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  await Promise.all(accounts.map(({ reader }) => reader.end()));
  await backend.close();
  for (const { id, login } of accounts) {
    await db.query('DELETE FROM queue WHERE account_id = $1', [id]);
    await db.query('DELETE FROM quarantine WHERE account_id = $1', [id]);
    await db.query('DELETE FROM events WHERE account_id = $1', [id]);
    await db.query(
      'DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = $1)',
      [id],
    );
    await db.query('DELETE FROM adapters WHERE account_id = $1', [id]);
    await db.query('DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = $1)', [id]);
    await db.query('DELETE FROM account_stores WHERE account_id = $1', [id]);
    await db.query('DELETE FROM api_keys WHERE account_id = $1', [id]);
    await db.query('DELETE FROM accounts WHERE id = $1', [id]);
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(login.database)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(login.user)}`);
  }
  await admin.end();
  await db.end();
});

describe('accounts provisioning to worker', () => {
  it('decrypts stored credentials with the worker function, and keeps the read-only database', async () => {
    const account = await newAccount();
    const { rows } = await db.query<{ credentials: Buffer; read_credentials: Buffer; connection: object; status: string }>(
      'SELECT credentials, read_credentials, connection, status FROM account_stores WHERE id = $1',
      [account.storeId],
    );
    const store = rows[0]!;
    expect(store.status).toBe('active');
    expect(Buffer.isBuffer(store.credentials)).toBe(true);
    expect(decryptCredentials(store.credentials)).toEqual({ user: 'sw_data', password: config.dataDbPassword });
    expect(store.connection).toEqual({ host: 'localhost', port: config.postgresPort, database: 'sw_data' });
    expect(decryptCredentials(store.read_credentials)).toEqual({
      user: account.login.user,
      password: account.login.password,
      database: account.login.database,
    });
  });

  it('a store made by the route loads and connects in a running worker', async () => {
    const account = await newAccount();
    const body = { id: 'u1', email: 'ada@example.com' };
    await addAdapter(account, body, `function adapt(p) { return { table: 'user', rows: [p.data] }; }`);
    await addEvent(account, body);

    const worker = startWorker({
      databaseUrl: config.appDatabaseUrl,
      decryptCredentials,
      accountId: account.id,
      pollMs: 20,
      concurrency: 1,
      log: () => {},
      sandboxLimits: { timeoutMs: 20_000 },
    });
    try {
      await vi.waitFor(
        async () => {
          const pending = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [account.id]);
          expect(pending.rowCount).toBe(0);
        },
        { timeout: 30_000, interval: 50 },
      );
    } finally {
      await worker.stop();
    }
    expect(await read(account, 'SELECT id, email FROM "user"')).toEqual([{ id: 'u1', email: 'ada@example.com' }]);
    expect(await openQuarantine(account)).toEqual([]);
  });
});

describe('the customer login', () => {
  it('reads tables added later, and can write nothing', async () => {
    const account = await newAccount();
    const body = { id: 'u1' };
    await addAdapter(account, body, `function adapt(p) { return { table: 'user', rows: [p.data] }; }`);
    await addEvent(account, body);
    await runJobs(account);

    const client = new pg.Client(account.login);
    await client.connect();
    try {
      expect((await client.query('SELECT id FROM "user"')).rows).toEqual([{ id: 'u1' }]);
      await expect(client.query(`INSERT INTO "user" (id, _event_seq) VALUES ('x', 1)`)).rejects.toThrow();
      // Read-only is only the default, so the privileges have to hold without it.
      await client.query('SET default_transaction_read_only = off');
      await expect(client.query(`INSERT INTO "user" (id, _event_seq) VALUES ('x', 1)`)).rejects.toThrow(/permission denied/);
      await expect(client.query(`UPDATE "user" SET _event_seq = 0`)).rejects.toThrow(/permission denied/);
      await expect(client.query(`DELETE FROM "user"`)).rejects.toThrow(/permission denied/);
      await expect(client.query('CREATE TABLE sneaky (a int)')).rejects.toThrow(/permission denied/);
      await expect(client.query('CREATE TEMP TABLE sneaky (a int)')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it.each(['sw_app', 'sw_data', 'postgres', 'template1'])('cannot connect to %s', async (database) => {
    const account = await newAccount();
    const client = new pg.Client({ ...account.login, database });
    client.on('error', () => {});
    await expect(client.connect()).rejects.toThrow(/permission denied/);
    await client.end().catch(() => {});
  });

  it("cannot connect to another account's store", async () => {
    const [first, second] = [await newAccount(), await newAccount()];
    const client = new pg.Client({ ...first.login, database: second.login.database });
    client.on('error', () => {});
    await expect(client.connect()).rejects.toThrow(/permission denied/);
    await client.end().catch(() => {});
  });
});

describe('full pipeline', () => {
  it('writes nested children and grandchildren with foreign keys and indexes', async () => {
    const account = await newAccount();
    const body = {
      id: 'o1',
      total: 19.5,
      paid: true,
      items: [
        { sku: 'A', qty: 1, options: [{ name: 'red' }, { name: 'large' }] },
        { sku: 'B', qty: 2, options: [{ name: 'blue' }] },
      ],
    };
    await addAdapter(
      account,
      body,
      `function adapt(p) {
        return { table: 'orders', rows: [{
          id: p.data.id, total: p.data.total, paid: p.data.paid,
          children: { items: { rows: p.data.items.map((item) => ({
            sku: item.sku, qty: item.qty,
            children: { options: { rows: item.options } },
          })) } },
        }] };
      }`,
    );
    await addEvent(account, body);
    expect(await runJobs(account)).toEqual(['done']);

    const orders = await read(account, 'SELECT id, total, paid, _event_seq, _deleted_at FROM orders');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ id: 'o1', total: '19.5', paid: true, _deleted_at: null });
    expect(typeof orders[0]!._event_seq).toBe('string');

    const items = await read(account, 'SELECT id, orders_id, sku, qty FROM orders_items ORDER BY sku');
    expect(items.map(({ orders_id, sku, qty }) => [orders_id, sku, qty])).toEqual([
      ['o1', 'A', '1'],
      ['o1', 'B', '2'],
    ]);
    const options = await read(account, 'SELECT orders_items_id, name FROM orders_items_options ORDER BY name');
    expect(options).toEqual([
      { orders_items_id: items[1]!.id, name: 'blue' },
      { orders_items_id: items[0]!.id, name: 'large' },
      { orders_items_id: items[0]!.id, name: 'red' },
    ]);

    const indexes = await read(account, `SELECT indexdef FROM pg_indexes WHERE tablename = 'orders_items'`);
    expect(indexes.some(({ indexdef }) => /\(orders_id\)/.test(indexdef))).toBe(true);
  });

  it('writes several top-level tables from an array, with the embedded record in its own table', async () => {
    const account = await newAccount();
    const body = { id: 'o1', customer: { id: 'c1', name: 'Ada' } };
    await addAdapter(
      account,
      body,
      `function adapt(p) {
        return [
          { table: 'customer', rows: [p.data.customer] },
          { table: 'orders', rows: [{ id: p.data.id, customer_id: p.data.customer.id }] },
        ];
      }`,
    );
    await addEvent(account, body);
    await runJobs(account);
    expect(await read(account, 'SELECT id, name FROM customer')).toEqual([{ id: 'c1', name: 'Ada' }]);
    expect(await read(account, 'SELECT id, customer_id FROM orders')).toEqual([{ id: 'o1', customer_id: 'c1' }]);
  });

  it('merges a partial update, and tells a missing key from undefined and null across the sandbox', async () => {
    const account = await newAccount();
    const full = { id: 'u1', email: 'a@example.com', name: 'Ada', age: 36, city: 'London' };
    await addAdapter(account, full, `function adapt(p) { return { table: 'user', rows: [p.data] }; }`);
    await addEvent(account, full);
    await runJobs(account);

    // Absent: `name` stays. Undefined: `email` clears. Null: `age` clears.
    const partial = { id: 'u1', city: 'Paris' };
    await addAdapter(
      account,
      partial,
      `function adapt(p) {
        return { table: 'user', rows: [{ id: p.data.id, city: p.data.city, email: undefined, age: null, never_seen: undefined, also_never: null }] };
      }`,
    );
    await addEvent(account, partial);
    await runJobs(account);

    expect(await read(account, 'SELECT id, email, name, age, city FROM "user"')).toEqual([
      { id: 'u1', email: null, name: 'Ada', age: null, city: 'Paris' },
    ]);
    const columns = await read(
      account,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user'`,
    );
    expect(columns.map(({ column_name }) => column_name)).not.toContain('never_seen');
    expect(columns.map(({ column_name }) => column_name)).not.toContain('also_never');
    expect(await openQuarantine(account)).toEqual([]);
  });

  it('soft-deletes through a DELETE with no body, using the id from the path, and a later write restores', async () => {
    const account = await newAccount();
    const body = { id: 'u1', email: 'a@example.com' };
    await addAdapter(account, body, `function adapt(p) { return { table: 'user', rows: [p.data] }; }`, { source: 'users' });
    await addAdapter(
      account,
      undefined,
      `function adapt(p) {
        if (p.data !== null) throw new Error('expected no body, got ' + JSON.stringify(p.data));
        return { table: 'user', rows: [{ id: p.request.path.split('/').pop(), _deleted: true }] };
      }`,
      { source: 'users', op: 'delete' },
    );

    await addEvent(account, body, { source: 'users' });
    await runJobs(account);
    const deleteId = await addEvent(account, undefined, { source: 'users', op: 'delete', path: '/ingest/users/u1' });
    expect(await runJobs(account)).toEqual(['done']);

    // Compared as text in one time zone, since a Date would hide a lost microsecond.
    const instant = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
    const { rows: logged } = await db.query<{ at: string; seq: string }>(
      `SELECT ${instant.replace('%s', 'received_at')} AS at, seq::text AS seq FROM events WHERE id = $1`,
      [deleteId],
    );
    const [deleted] = await read(
      account,
      `SELECT email, ${instant.replace('%s', '_deleted_at')} AS at, _event_seq FROM "user"`,
    );
    expect(deleted).toEqual({ email: 'a@example.com', at: logged[0]!.at, _event_seq: logged[0]!.seq });

    await addEvent(account, body, { source: 'users' });
    await runJobs(account);
    expect((await read(account, 'SELECT _deleted_at FROM "user"'))[0]!._deleted_at).toBeNull();
  });

  it('marks a child deleted from a per-item flag, and a shorter list removes nothing', async () => {
    const account = await newAccount();
    const body = { id: 'o1', items: [{ id: 'i1', sku: 'A' }, { id: 'i2', sku: 'B' }] };
    const code = `function adapt(p) {
      return { table: 'orders', rows: [{ id: p.data.id, children: { items: { rows: p.data.items.map((item) => {
        const { deleted, ...rest } = item;
        return deleted ? { ...rest, _deleted: true } : rest;
      }) } } }] };
    }`;
    await addAdapter(account, body, code);
    await addEvent(account, body);
    await runJobs(account);

    const removal = { id: 'o1', items: [{ id: 'i1', sku: 'A', deleted: true }] };
    await addAdapter(account, removal, code);
    await addEvent(account, removal);
    await runJobs(account);

    const items = await read(account, 'SELECT id, _deleted_at FROM orders_items ORDER BY id');
    expect(items[0]!.id).toBe('i1');
    expect(items[0]!._deleted_at).not.toBeNull();
    expect(items[1]).toEqual({ id: 'i2', _deleted_at: null });
  });

  it('collapses an opaque path for matching, and stores any value there as json', async () => {
    const account = await newAccount();
    const code = `function adapt(p) { return { table: 'thing', rows: [{ id: p.data.id, metadata: p.data.metadata }] }; }`;
    await addAdapter(account, { id: 'x', metadata: { a: 1 } }, code, { opaquePaths: ['metadata'] });

    await addEvent(account, { id: 't1', metadata: { color: 'red', nested: { deep: [1, 2] } } });
    await addEvent(account, { id: 't2', metadata: { size: 5 } });
    await addEvent(account, { id: 't3', metadata: 'just text' });
    expect(await runJobs(account)).toEqual(['done', 'done', 'done']);

    const things = await read(account, 'SELECT id, metadata FROM thing ORDER BY id');
    expect(things).toEqual([
      { id: 't1', metadata: { color: 'red', nested: { deep: [1, 2] } } },
      { id: 't2', metadata: { size: 5 } },
      { id: 't3', metadata: 'just text' },
    ]);
    const registered = await db.query(
      `SELECT logical_type FROM data_columns WHERE store_id = $1 AND table_name = 'thing' AND column_name = 'metadata'`,
      [account.storeId],
    );
    expect(registered.rows).toEqual([{ logical_type: 'json' }]);
  });

  it('stores declared timestamps as real timestamps, indexed, and compares by instant', async () => {
    const account = await newAccount();
    const body = { id: 'e1', at: '2026-03-01T12:00:00.123456+05:30', plain: '2026-03-01T12:00:00Z' };
    await addAdapter(
      account,
      body,
      `function adapt(p) { return { table: 'evt', column_types: { at: 'timestamp' }, rows: [p.data] }; }`,
    );
    await addEvent(account, body);
    await runJobs(account);

    const [row] = await read(
      account,
      `SELECT pg_typeof(at)::text AS at_type, pg_typeof(plain)::text AS plain_type, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS at_utc FROM evt`,
    );
    expect(row).toEqual({
      at_type: 'timestamp with time zone',
      plain_type: 'text',
      at_utc: '2026-03-01 06:30:00.123456',
    });
    const indexes = await read(account, `SELECT indexdef FROM pg_indexes WHERE tablename = 'evt'`);
    expect(indexes.some(({ indexdef }) => /\(at\)/.test(indexdef))).toBe(true);
  });

  it('keeps big integers exact as strings from the raw bytes to the table', async () => {
    const account = await newAccount();
    const raw = '{"id":12345678901234567890,"small":5,"ratio":1.5,"neg":-98765432109876543210}';
    const parsed = JSON.parse(raw);
    await addAdapter(account, parsed, `function adapt(p) {
      if (typeof p.data.id !== 'string') throw new Error('id should be a string');
      return { table: 'big', rows: [{ id: p.data.id, small: p.data.small, ratio: p.data.ratio, neg: p.data.neg }] };
    }`);
    await addEvent(account, parsed, { raw });
    expect(await runJobs(account)).toEqual(['done']);
    expect(await read(account, 'SELECT id, small, ratio, neg FROM big')).toEqual([
      { id: '12345678901234567890', small: '5', ratio: '1.5', neg: '-98765432109876543210' },
    ]);
  });

  // Same shape, same adapter. Whether an event lands depends on whether this value passes 2^53, so
  // PRD 12.1 has adapters cast ID-like fields, and the gate checks that. This documents what happens to an
  // adapter that passes a number through, which still applies to any other integer field.
  it('quarantines a passed-through integer field once its value passes 2^53', async () => {
    const account = await newAccount();
    const code = `function adapt(p) { return { table: 'line', rows: [{ id: String(p.data.id), product_id: p.data.product_id }] }; }`;
    await addAdapter(account, { id: 1, product_id: 1 }, code);
    await addEvent(account, { id: 1, product_id: 632910392 });
    const raw = '{"id":2,"product_id":788032119674292922}';
    await addEvent(account, JSON.parse(raw), { raw });
    expect(await runJobs(account)).toEqual(['done', 'quarantined']);
    const [conflict] = await openQuarantine(account);
    expect(conflict!.reason).toBe('schema_conflict');
    expect(conflict!.detail).toMatch(/line\.product_id is registered as number, but this event has string/);
    expect(await read(account, 'SELECT id, product_id FROM line')).toEqual([{ id: '1', product_id: '632910392' }]);
  });

  it('passes the logged request to the adapter as AdapterRequest', async () => {
    const account = await newAccount();
    const body = { id: 'r1' };
    await addAdapter(
      account,
      body,
      `function adapt(p) {
        return { table: 'seen', rows: [{ id: p.data.id, method: p.request.method, path: p.request.path, query: p.request.query, header: p.request.headers['x-github-event'], kinds: typeof p.request.headers }] };
      }`,
      { source: 'gh' },
    );
    await addEvent(account, body, { source: 'gh', path: '/ingest/gh/123', query: 'a=1&b=2', headers: { 'x-github-event': 'push' } });
    await runJobs(account);
    expect(await read(account, 'SELECT id, method, path, query, header, kinds FROM seen')).toEqual([
      { id: 'r1', method: 'POST', path: '/ingest/gh/123', query: 'a=1&b=2', header: 'push', kinds: 'object' },
    ]);
  });

  it('quarantines each failure with the right reason and writes nothing', async () => {
    const account = await newAccount();
    const cases: [string, unknown, string, string][] = [
      ['throws', { a: 1 }, `function adapt() { throw new Error('nope'); }`, 'adapter_error'],
      ['boolean', { b: 1 }, `function adapt() { return { table: 't', rows: [{ _deleted: false }] }; }`, 'adapter_error'],
      ['nan', { c: 1 }, `function adapt() { return { table: 't', rows: [{ n: NaN }] }; }`, 'adapter_error'],
      ['object', { d: 1 }, `function adapt() { return { table: 't', rows: [{ o: {} }] }; }`, 'adapter_error'],
      ['bad-id', { e: 1 }, `function adapt() { return { table: 't', rows: [{ id: 5 }] }; }`, 'adapter_error'],
      ['bad-table', { f: 1 }, `function adapt() { return { table: 'Bad Name', rows: [{}] }; }`, 'adapter_error'],
      ['nul', { g: 1 }, `function adapt() { return { table: 'nul', rows: [{ id: 'x', v: 'a\\u0000b' }] }; }`, 'write_error'],
    ];
    for (const [, body, code] of cases) await addAdapter(account, body, code);
    const ids = new Map<string, string>();
    for (const [name, body] of cases) ids.set(await addEvent(account, body), name);
    await addEvent(account, { unknown: 1 });
    await runJobs(account);

    const open = await openQuarantine(account);
    const reasons = Object.fromEntries(open.map(({ event_id, reason }) => [ids.get(event_id) ?? 'unknown', reason]));
    expect(reasons).toEqual({
      ...Object.fromEntries(cases.map(([name, , , reason]) => [name, reason])),
      unknown: 'unknown_fingerprint',
    });
    const tables = await read(account, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    // A permanent write failure rolls back its rows, but the schema change has already committed.
    expect(tables.map(({ table_name }) => table_name)).toEqual(['nul']);
    expect(await read(account, 'SELECT * FROM nul')).toEqual([]);
  });

  it('sends a type conflict to quarantine with nothing from the event written', async () => {
    const account = await newAccount();
    await addAdapter(account, { id: 'a', n: 1 }, `function adapt(p) { return { table: 'c', rows: [p.data] }; }`);
    await addEvent(account, { id: 'a', n: 1 });
    await addAdapter(account, { id: 'b', n: 'text', extra: true }, `function adapt(p) { return { table: 'c', rows: [p.data] }; }`);
    await addEvent(account, { id: 'b', n: 'text', extra: true });
    expect(await runJobs(account)).toEqual(['done', 'quarantined']);
    expect((await openQuarantine(account)).map(({ reason }) => reason)).toEqual(['schema_conflict']);
    expect(await read(account, 'SELECT id FROM c')).toEqual([{ id: 'a' }]);
    const columns = await read(
      account,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'c'`,
    );
    expect(columns.map(({ column_name }) => column_name)).not.toContain('extra');
  });

  it("only matches an adapter in the event's own account, source and op", async () => {
    const [first, second] = [await newAccount(), await newAccount()];
    const body = { id: 'x' };
    await addAdapter(first, body, `function adapt(p) { return { table: 'mine', rows: [p.data] }; }`, { source: 'a' });
    await addEvent(second, body, { source: 'a' });
    await addEvent(first, body, { source: 'b' });
    await addEvent(first, body, { source: 'a', op: 'delete' });
    await runJobs(first);
    await runJobs(second);
    expect((await openQuarantine(first)).map(({ reason }) => reason)).toEqual(['unknown_fingerprint', 'unknown_fingerprint']);
    expect((await openQuarantine(second)).map(({ reason }) => reason)).toEqual(['unknown_fingerprint']);
  });

  it('keeps one open row when an event with no adapter is quarantined twice', async () => {
    const account = await newAccount();
    const eventId = await addEvent(account, { nobody: 'handles this' });
    await runJobs(account);
    await db.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [account.id, eventId]);
    await runJobs(account);
    expect((await openQuarantine(account)).map(({ reason }) => reason)).toEqual(['unknown_fingerprint']);
  });

  it('keeps the exact body, including a NUL escape, duplicate keys and key order', async () => {
    const account = await newAccount();
    const raw = '{"b":1,"a":"x\\u0000y","b":2}';
    await addEvent(account, JSON.parse(raw), { raw });
    await runJobs(account);
    const { rows } = await db.query<{ body: Buffer }>('SELECT body FROM events WHERE account_id = $1', [account.id]);
    expect(rows[0]!.body.toString('utf8')).toBe(raw);
  });
});

describe('concurrent workers', () => {
  it('merges overlapping events, racing new columns and opposite row orders, with nothing lost', async () => {
    const account = await newAccount();
    // Each event adds its own column to two shared rows, in an order that varies, so transactions
    // can deadlock and schema changes race. A deadlock retries, so only the outcome is checked.
    await addAdapter(
      account,
      { n: 1 },
      `function adapt(p) {
        const n = p.data.n;
        const rows = [{ id: 'a', ['c' + n]: n, last: n }, { id: 'b', ['c' + n]: n, last: n }];
        return { table: 'shared', rows: n % 2 ? rows : rows.reverse() };
      }`,
    );
    const count = 30;
    for (let n = 0; n < count; n += 1) await addEvent(account, { n });

    const worker = startWorker({
      databaseUrl: config.appDatabaseUrl,
      decryptCredentials,
      accountId: account.id,
      pollMs: 20,
      concurrency: 4,
      backoffBaseMs: 50,
      backoffMaxMs: 200,
      log: () => {},
      sandboxLimits: { timeoutMs: 20_000 },
    });
    try {
      await vi.waitFor(
        async () => {
          const pending = await db.query('SELECT 1 FROM queue WHERE account_id = $1', [account.id]);
          expect(pending.rowCount).toBe(0);
        },
        { timeout: 50_000, interval: 100 },
      );
    } finally {
      await worker.stop();
    }

    expect(await openQuarantine(account)).toEqual([]);
    const rows = await read(account, 'SELECT * FROM shared ORDER BY id');
    expect(rows.map(({ id }) => id)).toEqual(['a', 'b']);
    const newest = await db.query<{ seq: string }>('SELECT max(seq)::text AS seq FROM events WHERE account_id = $1', [
      account.id,
    ]);
    for (const row of rows) {
      for (let n = 0; n < count; n += 1) expect(row[`c${n}`]).toBe(String(n));
      expect(row._event_seq).toBe(newest.rows[0]!.seq);
      // The newest event is the last one inserted, so its value must win however the workers ran.
      expect(row.last).toBe(String(count - 1));
    }
    const registered = await db.query(
      `SELECT 1 FROM data_columns WHERE store_id = $1 AND table_name = 'shared'`,
      [account.storeId],
    );
    // `id`, `last`, and one per event.
    expect(registered.rowCount).toBe(count + 2);
  });
});

describe('replaying an event', () => {
  /** Runs an event's job again, as a lost lease or a replay would. */
  async function repeat(account: Account, eventId: string): Promise<void> {
    await db.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [account.id, eventId]);
    expect(await runJobs(account)).toEqual(['done']);
  }

  it('produces the same injected IDs and _deleted_at, to the microsecond', async () => {
    const account = await newAccount();
    const body = {
      id: 'o1',
      items: [{ sku: 'A', notes: [{ text: 'n1' }] }, { sku: 'B', notes: [{ text: 'n2' }] }],
      logs: [{ msg: 'x' }],
    };
    await addAdapter(
      account,
      body,
      `function adapt(p) {
        return [
          { table: 'orders', rows: [{
            id: p.data.id,
            _deleted: true,
            children: {
              items: { rows: p.data.items.map((item) => ({ sku: item.sku, children: { notes: { rows: item.notes } } })) },
              logs: { append: true, rows: p.data.logs },
            },
          }] },
          { table: 'anon', rows: [{ v: 1, _deleted: true }, { v: 2 }] },
        ];
      }`,
    );
    const eventId = await addEvent(account, body);
    await runJobs(account);

    const snapshot = async () => ({
      orders: await read(account, `SELECT id, _event_seq, _deleted_at::text FROM orders ORDER BY id`),
      items: await read(account, 'SELECT * FROM orders_items ORDER BY id'),
      notes: await read(account, 'SELECT * FROM orders_items_notes ORDER BY id'),
      logs: await read(account, 'SELECT * FROM orders_logs ORDER BY id'),
      anon: await read(account, 'SELECT id, v, _event_seq, _deleted_at::text FROM anon ORDER BY id'),
    });

    const before = await snapshot();
    expect(before.orders).toHaveLength(1);
    expect(before.items).toHaveLength(2);
    expect(before.notes).toHaveLength(2);
    expect(before.logs).toHaveLength(1);
    expect(before.anon).toHaveLength(2);
    // Fractional seconds, which a JavaScript Date would have cut to milliseconds.
    expect(before.orders[0]!._deleted_at).toMatch(/\.\d+\+/);

    await repeat(account, eventId);
    expect(await snapshot()).toEqual(before);
  });

  it('a repeat of a parent updates its positional children, and append children get new rows', async () => {
    const account = await newAccount();
    const body = { id: 'o1', items: [{ sku: 'A' }], logs: [{ msg: 'x' }] };
    await addAdapter(
      account,
      body,
      `function adapt(p) {
        return { table: 'orders', rows: [{ id: p.data.id, children: {
          items: { rows: p.data.items },
          logs: { append: true, rows: p.data.logs },
        } }] };
      }`,
    );
    await addEvent(account, body);
    await addEvent(account, { id: 'o1', items: [{ sku: 'A2' }], logs: [{ msg: 'y' }] });
    await runJobs(account);
    expect(await read(account, 'SELECT sku FROM orders_items')).toEqual([{ sku: 'A2' }]);
    expect((await read(account, 'SELECT msg FROM orders_logs ORDER BY msg')).map(({ msg }) => msg)).toEqual(['x', 'y']);
  });

  it('an older event replayed after a newer one keeps the newer values and fills only gaps', async () => {
    const account = await newAccount();
    const first = { id: 'u1', a: 'old', b: 'old' };
    const code = `function adapt(p) { return { table: 'u', rows: [p.data] }; }`;
    await addAdapter(account, first, code);
    const older = await addEvent(account, first);
    await runJobs(account);
    const later = { id: 'u1', a: 'new', c: 'new' };
    await addAdapter(account, later, code);
    await addEvent(account, later);
    await runJobs(account);

    await repeat(account, older);
    const [row] = await read(account, 'SELECT a, b, c FROM u');
    expect(row).toEqual({ a: 'new', b: 'old', c: 'new' });
  });

  it('a delayed delete does not touch a newer row, and a delayed write does not restore a newer delete', async () => {
    const account = await newAccount();
    const body = { id: 'u1', v: 1 };
    await addAdapter(account, body, `function adapt(p) { return { table: 'u', rows: [p.data] }; }`);
    await addAdapter(account, { id: 'u1' }, `function adapt(p) { return { table: 'u', rows: [{ id: p.data.id, _deleted: true }] }; }`, { op: 'delete' });

    const write = await addEvent(account, body);
    const remove = await addEvent(account, { id: 'u1' }, { op: 'delete' });
    await runJobs(account);
    expect((await read(account, 'SELECT _deleted_at FROM u'))[0]!._deleted_at).not.toBeNull();

    await repeat(account, write);
    expect((await read(account, 'SELECT _deleted_at FROM u'))[0]!._deleted_at).not.toBeNull();

    await addEvent(account, { id: 'u1', v: 2 });
    await runJobs(account);
    expect((await read(account, 'SELECT _deleted_at FROM u'))[0]!._deleted_at).toBeNull();

    await repeat(account, remove);
    expect((await read(account, 'SELECT _deleted_at, v FROM u'))[0]).toEqual({ _deleted_at: null, v: '2' });
  });
});

describe('real HTTP to /ingest', () => {
  let server: ReturnType<typeof serve>;
  let base: string;

  beforeAll(async () => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function loggedRequest(eventId: string) {
    const { rows } = await db.query<{ request: { method: string; path: string; query: string; headers: Record<string, string> }; source: string; op: string; fingerprint: string | null }>(
      'SELECT request, source, op, fingerprint FROM events WHERE id = $1',
      [eventId],
    );
    return rows[0]!;
  }

  it('takes a request from the socket to the customer login, keeping big integers exact', async () => {
    const account = await newAccount();
    const raw = '{"id":12345678901234567890,"email":"ada@example.com"}';
    await addAdapter(
      account,
      JSON.parse(raw),
      `function adapt(p) {
        return { table: 'user', rows: [{ id: p.data.id, email: p.data.email, path: p.request.path, query: p.request.query, seen_key: String('key' in p.request.headers) }] };
      }`,
      { source: 'users' },
    );

    const response = await fetch(`${base}/ingest/users/42?a=1&key=${encodeURIComponent(account.apiKey)}&b=2`, {
      method: 'PUT',
      headers: { 'x-account-slug': account.slug, Cookie: 'secret=1', 'X-Api-Key': 'secret', 'X-Thing': 'kept' },
      body: raw,
    });
    expect(response.status).toBe(202);
    const { status, event_id: eventId } = (await response.json()) as { status: string; event_id: string };
    expect(status).toBe('queued');

    const logged = await loggedRequest(eventId);
    expect(logged).toMatchObject({ source: 'users', op: 'write', fingerprint: fingerprint(JSON.parse(raw)) });
    expect(logged.request).toMatchObject({ method: 'PUT', path: '/ingest/users/42', query: 'a=1&b=2' });
    expect(logged.request.headers['x-thing']).toBe('kept');
    for (const name of ['authorization', 'cookie', 'x-api-key']) expect(logged.request.headers).not.toHaveProperty(name);
    expect(JSON.stringify(logged.request)).not.toContain(account.apiKey);

    expect(await runJobs(account)).toEqual(['done']);
    expect(await read(account, 'SELECT id, email, path, query, seen_key FROM "user"')).toEqual([
      { id: '12345678901234567890', email: 'ada@example.com', path: '/ingest/users/42', query: 'a=1&b=2', seen_key: 'false' },
    ]);
  });

  it('soft-deletes through a real DELETE with no body', async () => {
    const account = await newAccount();
    const body = { id: 'u1', email: 'a@example.com' };
    await addAdapter(account, body, `function adapt(p) { return { table: 'user', rows: [p.data] }; }`, { source: 'users' });
    await addAdapter(
      account,
      undefined,
      `function adapt(p) { return { table: 'user', rows: [{ id: p.request.path.split('/').pop(), _deleted: true }] }; }`,
      { source: 'users', op: 'delete' },
    );
    const headers = { authorization: `Bearer ${account.apiKey}`, 'x-account-slug': account.slug };

    expect((await fetch(`${base}/ingest/users`, { method: 'POST', headers, body: JSON.stringify(body) })).status).toBe(202);
    await runJobs(account);
    const deleted = await fetch(`${base}/ingest/users/u1`, { method: 'DELETE', headers });
    expect(deleted.status).toBe(202);
    expect(await runJobs(account)).toEqual(['done']);

    const [row] = await read(account, 'SELECT email, _deleted_at FROM "user"');
    expect(row!.email).toBe('a@example.com');
    expect(row!._deleted_at).not.toBeNull();
  });

  it('keeps a body that is not an object as a malformed event, with no job', async () => {
    const account = await newAccount();
    const response = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.apiKey}`, 'x-account-slug': account.slug },
      body: '"just a string"',
    });
    expect(response.status).toBe(202);
    const { status } = (await response.json()) as { status: string };
    expect(status).toBe('malformed');
    expect((await openQuarantine(account)).map(({ reason }) => reason)).toEqual(['malformed']);
    expect(await runJobs(account)).toEqual([]);
  });

  describe('the Shopify fixtures', () => {
    // A stand-in for a generated adapter that follows PRD 12.1: every field is carried, IDs are cast to
    // strings, date-times are declared, and nested data becomes child tables.
    const SHOPIFY_ADAPTER = `function adapt(p) {
      const isDateTime = (v) => typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/.test(v);
      const isId = (k) => k === 'id' || /_id$/.test(k);
      // The default {parent}_{key} goes past the 63-character limit on Shopify's deep money sets.
      const childName = (parent, key) => {
        const full = parent + '_' + key;
        return full.length <= 50 ? full : parent + '_' + key.split('_').map((word) => word[0]).join('');
      };
      const asTable = (items, name) => {
        const column_types = {};
        const rows = items.map((item) => {
          const row = {};
          const children = {};
          for (const key of Object.keys(item)) {
            const value = item[key];
            if (Array.isArray(value)) {
              if (value.length === 0) continue;
              const objects = value.every((v) => typeof v === 'object' && v !== null);
              children[key] = asTable(objects ? value : value.map((v) => ({ value: v })), childName(name, key));
            } else if (typeof value === 'object' && value !== null) {
              children[key] = asTable([value], childName(name, key));
            } else if (typeof value === 'number' && isId(key)) {
              row[key] = String(value);
            } else {
              if (isDateTime(value)) column_types[key] = 'timestamp';
              row[key] = value;
            }
          }
          if (Object.keys(children).length > 0) row.children = children;
          return row;
        });
        return { table: name, column_types, rows };
      };
      return asTable([p.data], p.request.headers['x-shopify-topic'].split('/')[0]);
    }`;

    async function deliver(account: Account, step: AnyShopifyStep): Promise<{ status: number; eventId: string; state: string }> {
      const response = await fetch(`${base}${step.path}?key=${encodeURIComponent(account.apiKey)}`, {
        method: step.method,
        headers: { ...step.headers, 'x-account-slug': account.slug },
        body: JSON.stringify(step.body),
      });
      const body = (await response.json()) as { status: string; event_id: string };
      return { status: response.status, eventId: body.event_id, state: body.status };
    }

    async function withAdapters(account: Account): Promise<void> {
      const shapes = new Set(shopifyFlows.flatMap((flow) => flow.steps.map((step) => fingerprint(step.body))));
      for (const shape of shapes) {
        await db.query(
          `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, active, validated_at)
           VALUES ($1, 'shopify', 'write', $2, 1, $3, true, now())`,
          [account.id, shape, SHOPIFY_ADAPTER],
        );
      }
    }

    it.each(shopifyFlows.map((flow) => [flow.id, flow] as const))('plays the %s flow into typed tables', async (_id, flow) => {
      const account = await newAccount();
      await withAdapters(account);

      for (const step of flow.steps) {
        const { status, state, eventId } = await deliver(account, step);
        expect([status, state]).toEqual([202, 'queued']);
        const logged = await loggedRequest(eventId);
        expect(logged).toMatchObject({ source: 'shopify', op: 'write' });
        expect(logged.request.query).toBe('');
        expect(logged.request.headers['x-shopify-topic']).toBe(step.topic);
        expect(JSON.stringify(logged.request)).not.toContain(account.apiKey);
      }
      expect(await runJobs(account)).toEqual(flow.steps.map(() => 'done'));
      expect(await openQuarantine(account)).toEqual([]);

      const tables = await read(account, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
      expect(tables.length).toBeGreaterThan(1);
      const idTypes = await read(
        account,
        `SELECT DISTINCT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND (column_name = 'id' OR column_name LIKE '%\\_id')`,
      );
      expect(idTypes).toEqual([{ data_type: 'text' }]);
      const created = await read(
        account,
        `SELECT DISTINCT data_type FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'created_at'`,
      );
      expect(created).toEqual([{ data_type: 'timestamp with time zone' }]);
    });

    it('merges the product update into one row, with both flows sharing one account', async () => {
      const account = await newAccount();
      await withAdapters(account);
      for (const flow of shopifyFlows) for (const step of flow.steps) await deliver(account, step);
      await runJobs(account);
      expect(await openQuarantine(account)).toEqual([]);

      const productId = String((productFlow.steps[0].body as { id: number }).id);
      const products = await read(account, 'SELECT id, status FROM products');
      expect(products.map(({ id }) => id)).toEqual([productId]);
      expect(products[0]!.status).toBe((productFlow.steps.at(-1)!.body as { status: string }).status);
      const variants = await read(account, 'SELECT DISTINCT products_id FROM products_variants');
      expect(variants).toEqual([{ products_id: productId }]);
      const orders = await read(account, 'SELECT id FROM orders');
      expect(orders.map(({ id }) => id)).toEqual([String((orderFlow.steps[0].body as { id: number }).id)]);
    });

    it('treats a retry as the same event, and a fresh delivery as new work that changes no row count', async () => {
      const account = await newAccount();
      await withAdapters(account);
      const step = productFlow.steps[0];
      const first = await deliver(account, step);
      const retry = await deliver(account, step);
      expect(retry.eventId).toBe(first.eventId);
      const events = await db.query('SELECT 1 FROM events WHERE account_id = $1', [account.id]);
      expect(events.rowCount).toBe(1);
      await runJobs(account);
      const count = async () => (await read(account, 'SELECT count(*)::int AS n FROM products_variants'))[0]!.n;
      const before = await count();

      const fresh = await deliver(account, freshDelivery(step));
      expect(fresh.eventId).not.toBe(first.eventId);
      expect(await runJobs(account)).toEqual(['done']);
      expect(await count()).toBe(before);
      expect(await openQuarantine(account)).toEqual([]);
    });
  });

  describe('the demo clients against the real server', () => {
    it("the site's client reaches /ingest with its slug and bearer key", async () => {
      const account = await newAccount();
      const log = new RequestLog();
      const send = createIngestClient({ url: `${base}/ingest`, apiKey: account.apiKey, accountSlug: account.slug, log });
      const entry = await send({ label: 'test', method: 'POST', path: 'speakers', body: { id: 'sp1', name: 'Ada' } });
      expect(entry.response?.status).toBe(202);
      expect(JSON.stringify(entry)).not.toContain(account.apiKey);
      const { event_id: eventId } = entry.response!.body as { event_id: string };
      expect((await loggedRequest(eventId)).source).toBe('speakers');
    });

    it("the console's raw client sends a webhook with the key in the URL, and a body-less DELETE", async () => {
      const account = await newAccount();
      const log = new RequestLog();
      const send = createRawIngestClient({ url: `${base}/ingest`, apiKey: account.apiKey, accountSlug: account.slug, log });
      const step = productFlow.steps[0];
      const webhook = await send({
        label: 'test',
        method: step.method,
        path: 'shopify?x=1',
        headers: step.headers as unknown as Record<string, string>,
        body: JSON.stringify(step.body),
        auth: 'key',
      });
      expect(webhook.response?.status).toBe(202);
      expect(webhook.url).not.toContain(account.apiKey);
      expect(JSON.stringify(webhook)).not.toContain(account.apiKey);
      const logged = await loggedRequest((webhook.response!.body as { event_id: string }).event_id);
      expect(logged.request.query).toBe('x=1');

      const removal = await send({ label: 'test', method: 'DELETE', path: 'shopify/1', headers: {}, body: null, auth: 'bearer' });
      expect(removal.response?.status).toBe(202);
    });
  });

  describe('the stub against the real server', () => {
    let stub: Stub;
    let stubBase: string;
    let account: Account;

    beforeAll(async () => {
      stub = await startStub();
      stubBase = stub.url.replace(/\/ingest$/, '');
      account = await newAccount();
    });

    afterAll(async () => {
      await stub.close();
    });

    const auth = () => ({ authorization: `Bearer ${account.apiKey}` });
    const cases: [string, string, () => RequestInit][] = [
      ['a plain write', '/ingest', () => ({ method: 'POST', headers: auth(), body: '{"a":1}' })],
      ['a write with a path', '/ingest/users/1', () => ({ method: 'PATCH', headers: auth(), body: '{"a":1}' })],
      ['an array body', '/ingest', () => ({ method: 'PUT', headers: auth(), body: '[{"a":1}]' })],
      ['a scalar', '/ingest', () => ({ method: 'POST', headers: auth(), body: '5' })],
      ['a null', '/ingest', () => ({ method: 'POST', headers: auth(), body: 'null' })],
      ['a DELETE with null', '/ingest', () => ({ method: 'DELETE', headers: auth(), body: 'null' })],
      ['a DELETE with no body', '/ingest/a', () => ({ method: 'DELETE', headers: auth() })],
      ['a POST with no body', '/ingest', () => ({ method: 'POST', headers: auth() })],
      ['invalid JSON', '/ingest', () => ({ method: 'POST', headers: auth(), body: '{ nope' })],
      ['a GET', '/ingest', () => ({ method: 'GET', headers: auth() })],
      ['no key', '/ingest', () => ({ method: 'POST', body: '{}' })],
      ['another path', '/ingestfoo', () => ({ method: 'POST', headers: auth(), body: '{}' })],
      ['a bad escape', '/ingest/%ff', () => ({ method: 'POST', headers: auth(), body: '{}' })],
      ['a NUL escape', '/ingest/%00', () => ({ method: 'POST', headers: auth(), body: '{}' })],
      ['a long source', `/ingest/${'a'.repeat(256)}`, () => ({ method: 'POST', headers: auth(), body: '{}' })],
      ['a source long only when encoded', `/ingest/${'%41'.repeat(100)}`, () => ({ method: 'POST', headers: auth(), body: '{}' })],
      ['a long Idempotency-Key', '/ingest', () => ({ method: 'POST', headers: { ...auth(), 'idempotency-key': 'k'.repeat(256) }, body: '{}' })],
      ['a BOM', '/ingest', () => ({ method: 'POST', headers: auth(), body: Buffer.from('\ufeff{}') })],
      ['invalid UTF-8', '/ingest', () => ({ method: 'POST', headers: auth(), body: Buffer.from([0x7b, 0xff, 0x7d]) })],
    ];

    it.each(cases)('agrees on %s', async (_name, path, init) => {
      const call = async (target: string, extra: Record<string, string>) => {
        const options = init();
        const response = await fetch(`${target}${path}`, { ...options, headers: { ...(options.headers as Record<string, string>), ...extra } });
        const body = (await response.json().catch(() => ({}))) as { status?: string };
        return { status: response.status, state: body.status };
      };
      const real = await call(base, { 'x-account-slug': account.slug });
      const fake = await call(stubBase, {});
      expect(fake).toEqual(real);
    });
  });
});

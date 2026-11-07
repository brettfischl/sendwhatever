// The live tables panel against real Postgres (PRD §20). This lives in test/ so that `vitest run demo`
// still needs no database.
import { randomBytes } from 'node:crypto';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { StoreConfig } from '../src/contracts/index.js';
import { createApp } from '../src/http/app.js';
import { decryptJson } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { RequestLog } from '../demo/ingest-client.js';
import { createDemoServer, SiteEvents } from '../demo/server.js';
import { createTablesSource, type EventView, type TablesResponse, type TableView, type TablesSource } from '../demo/tables.js';
import { Webinar } from '../demo/webinar.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const tracker = (await import(new URL('../demo/public/tables-tracker.js', import.meta.url).href)) as {
  createTracker: () => { tables: (response: object, now: number) => any[] };
};

const TOKEN = 'live-tables-test-token';
const config = { ...loadConfig(), internalApiToken: TOKEN };
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

interface Account {
  id: string;
  slug: string;
  readPassword: string;
  store: StoreConfig;
  storeId: string;
}

const accounts: Account[] = [];

async function createAccount(): Promise<Account> {
  const slug = `tables-${randomBytes(5).toString('hex')}`;
  const res = await app.request('/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { account_id: string; database: { password: string } };
  const { rows } = await appDb.query<{ id: string; namespace: string; connection: Record<string, unknown>; credentials: Buffer }>(
    'SELECT id, namespace, connection, credentials FROM account_stores WHERE account_id = $1',
    [created.account_id],
  );
  const row = rows[0]!;
  const account: Account = {
    id: created.account_id,
    slug,
    readPassword: created.database.password,
    storeId: row.id,
    store: {
      namespace: row.namespace,
      connection: row.connection,
      credentials: decryptJson(config.encryptionKey, row.credentials),
    },
  };
  accounts.push(account);
  return account;
}

function sourceFor(account: { slug: string }): TablesSource {
  return createTablesSource({
    appDatabaseUrl: config.appDatabaseUrl,
    encryptionKey: config.encryptionKey,
    accountSlug: account.slug,
  });
}

function ready(response: TablesResponse) {
  if (response.state !== 'ready') throw new Error(`Expected ready, got ${JSON.stringify(response)}`);
  return response;
}

const find = (tables: TableView[], name: string) => {
  const table = tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`No table ${name}`);
  return table;
};
const cell = (table: TableView, rowIndex: number, column: string) =>
  table.rows[rowIndex]!.values[table.columns.findIndex(({ name }) => name === column)];

let account: Account;
let other: Account;
let source: TablesSource;
let server: Server;
let base: string;

async function poll<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

beforeAll(async () => {
  account = await createAccount();
  other = await createAccount();
  source = sourceFor(account);
  server = createDemoServer(
    {
      webinar: new Webinar(async () => undefined as never),
      log: new RequestLog(),
      target: { mode: 'real', url: 'http://127.0.0.1:1/ingest', accountSlug: account.slug },
      tables: source,
    },
    new SiteEvents(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await source.close();
  await backend.close();

  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  for (const { id, store } of accounts) {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(store.namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(store.namespace))}`);
    await appDb.query('DELETE FROM adapter_attempts WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM queue WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM quarantine WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM adapters WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM events WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM api_keys WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM account_stores WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.end();
});

describe('watching tables appear', () => {
  it('shows new tables, columns, and rows without a restart, and the tracker marks each', async () => {
    const t = tracker.createTracker();

    const empty = await poll<TablesResponse>('/api/tables');
    expect(ready(empty)).toMatchObject({ database: account.store.namespace, tables: [] });
    t.tables(empty, 1000);

    // A table named like a reserved word, with a column too.
    await backend.applySchema(account.store, [{ kind: 'create_table', table: 'order' }]);
    const created = await poll<TablesResponse>('/api/tables');
    const newTable = find(ready(created).tables, 'order');
    expect(newTable.columns.map(({ name }) => name)).toEqual(['id', '_event_seq', '_deleted_at']);
    expect(newTable).toMatchObject({ rowCount: 0, rows: [] });
    expect(t.tables(created, 2000)[0]).toMatchObject({ name: 'order', since: 2000 });

    await backend.applySchema(account.store, [
      { kind: 'add_column', table: 'order', column: 'select', type: 'string' },
      { kind: 'add_column', table: 'order', column: 'total', type: 'number' },
    ]);
    const altered = await poll<TablesResponse>('/api/tables');
    expect(find(ready(altered).tables, 'order').columns).toEqual(
      expect.arrayContaining([
        { name: 'select', type: 'text' },
        { name: 'total', type: 'numeric' },
      ]),
    );
    const alteredView = t.tables(altered, 3000)[0];
    const newColumns = alteredView.columns.filter((column: { since: number | null }) => column.since === 3000);
    expect(newColumns.map(({ name }: { name: string }) => name)).toEqual(['select', 'total']);

    await backend.write(account.store, [
      {
        table: 'order',
        columns: { select: 'string', total: 'number' },
        rows: [{ id: 'o-1', _event_seq: '1', select: 'first', total: 12.5 }],
      },
    ]);
    const written = await poll<TablesResponse>('/api/tables');
    const withRow = find(ready(written).tables, 'order');
    expect(withRow.rowCount).toBe(1);
    expect(cell(withRow, 0, 'select')).toBe('first');
    expect(t.tables(written, 4000)[0].rows[0]).toMatchObject({ id: 'o-1', kind: 'new', since: 4000 });
  });

  it('passes a value holding HTML through untouched, for the panel to show as text', async () => {
    const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await backend.applySchema(account.store, [
      { kind: 'create_table', table: 'notes' },
      { kind: 'add_column', table: 'notes', column: 'body', type: 'string' },
    ]);
    await backend.write(account.store, [
      { table: 'notes', columns: { body: 'string' }, rows: [{ id: 'n-1', _event_seq: '1', body: html }] },
    ]);
    const { tables } = ready(await poll<TablesResponse>('/api/tables'));
    expect(cell(find(tables, 'notes'), 0, 'body')).toBe(html);
  });

  it('marks soft-deleted rows, keeps their data, and orders the newest first', async () => {
    await backend.applySchema(account.store, [
      { kind: 'create_table', table: 'user' },
      { kind: 'add_column', table: 'user', column: 'email', type: 'string' },
    ]);
    await backend.write(account.store, [
      {
        table: 'user',
        columns: { email: 'string' },
        rows: [
          { id: 'u-1', _event_seq: '10', email: 'a@example.com' },
          { id: 'u-2', _event_seq: '11', email: 'b@example.com', _deleted_at: '2026-11-07T10:00:00.000Z' },
        ],
      },
    ]);
    const table = find(ready(await poll<TablesResponse>('/api/tables')).tables, 'user');
    expect(table).toMatchObject({ rowCount: 2, deletedCount: 1 });
    expect(table.rows.map(({ id, deleted }) => [id, deleted])).toEqual([
      ['u-2', true],
      ['u-1', false],
    ]);
    expect(cell(table, 0, 'email')).toBe('b@example.com');
    expect(cell(table, 0, '_deleted_at')).toContain('2026-11-07');
    expect(table.rows[0]!.seq).toBe('11');
  });

  it('keeps large numbers exact, shows other types as text, and cuts long values', async () => {
    await backend.applySchema(account.store, [
      { kind: 'create_table', table: 'types' },
      { kind: 'add_column', table: 'types', column: 'amount', type: 'number' },
      { kind: 'add_column', table: 'types', column: 'flag', type: 'boolean' },
      { kind: 'add_column', table: 'types', column: 'meta', type: 'json' },
      { kind: 'add_column', table: 'types', column: 'long', type: 'string' },
      { kind: 'add_column', table: 'types', column: 'empty', type: 'string' },
    ]);
    await backend.write(account.store, [
      {
        table: 'types',
        columns: { amount: 'number', flag: 'boolean', meta: 'json', long: 'string', empty: 'string' },
        rows: [
          {
            id: 't-1',
            _event_seq: '9007199254740993',
            amount: '12345678901234567890.5',
            flag: true,
            meta: { a: 1 },
            long: 'x'.repeat(5000),
            empty: null,
          },
        ],
      },
    ]);
    const table = find(ready(await poll<TablesResponse>('/api/tables')).tables, 'types');
    expect(table.rows[0]!.seq).toBe('9007199254740993');
    expect(cell(table, 0, 'amount')).toBe('12345678901234567890.5');
    expect(cell(table, 0, 'flag')).toBe('true');
    expect(JSON.parse(cell(table, 0, 'meta')!)).toEqual({ a: 1 });
    expect(cell(table, 0, 'long')).toBe(`${'x'.repeat(200)}…`);
    expect(cell(table, 0, 'empty')).toBeNull();
  });

  it('copes with column names that mean something to JavaScript', async () => {
    await backend.applySchema(account.store, [
      { kind: 'create_table', table: 'odd' },
      { kind: 'add_column', table: 'odd', column: '__proto__', type: 'string' },
      { kind: 'add_column', table: 'odd', column: 'constructor', type: 'string' },
      { kind: 'add_column', table: 'odd', column: 'with "quotes"', type: 'string' },
    ]);
    await backend.write(account.store, [
      {
        table: 'odd',
        columns: Object.fromEntries([
          ['__proto__', 'string'],
          ['constructor', 'string'],
          ['with "quotes"', 'string'],
        ]),
        rows: [
          Object.fromEntries([
            ['id', 'x-1'],
            ['_event_seq', '1'],
            ['__proto__', 'p'],
            ['constructor', 'c'],
            ['with "quotes"', 'q'],
          ]) as never,
        ],
      },
    ]);
    const table = find(ready(await poll<TablesResponse>('/api/tables')).tables, 'odd');
    expect(cell(table, 0, '__proto__')).toBe('p');
    expect(cell(table, 0, 'constructor')).toBe('c');
    expect(cell(table, 0, 'with "quotes"')).toBe('q');
  });

  it('shows only the latest rows, with the full count', async () => {
    await backend.applySchema(account.store, [{ kind: 'create_table', table: 'many' }]);
    await backend.write(account.store, [
      {
        table: 'many',
        columns: {},
        rows: Array.from({ length: 8 }, (_, index) => ({ id: `m-${index}`, _event_seq: String(index + 1) })),
      },
    ]);
    const table = find(ready(await poll<TablesResponse>('/api/tables')).tables, 'many');
    expect(table.rowCount).toBe(8);
    expect(table.rows.map(({ id }) => id)).toEqual(['m-7', 'm-6', 'm-5', 'm-4', 'm-3']);
  });
});

describe('how the panel reaches the store', () => {
  it('connects as the store login, to the store database, and not to sw_data', async () => {
    await poll('/api/tables');
    const { rows } = await appDb.query<{ usename: string; datname: string }>(
      `SELECT usename, datname FROM pg_stat_activity
       WHERE application_name = 'sw-demo-tables-store' AND datname = $1`,
      [account.store.namespace],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toEqual({ usename: readOnlyRoleName(account.store.namespace), datname: account.store.namespace });
    }
  });

  it('never shows another store', async () => {
    await backend.applySchema(other.store, [{ kind: 'create_table', table: 'other_secret' }]);
    const { tables } = ready(await poll<TablesResponse>('/api/tables'));
    expect(tables.map(({ name }) => name)).not.toContain('other_secret');

    const otherSource = sourceFor(other);
    const { tables: theirs } = ready(await otherSource.tables());
    expect(theirs.map(({ name }) => name)).toEqual(['other_secret']);
    await otherSource.close();
  });

  it('refuses a request whose Host is not loopback, so DNS rebinding cannot read it', async () => {
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request(`${base}/api/tables`, { headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    expect(await statusFor('evil.example')).toBe(403);
    expect(await statusFor('evil.example:3100')).toBe(403);
    expect(await statusFor('127.0.0.1')).toBe(200);
    expect(await statusFor('localhost:3100')).toBe(200);
  });

  it('keeps the newest tables past the limit, listed by name', async () => {
    const crowded = await createAccount();
    const names = Array.from({ length: 41 }, (_, index) => `t${String(index).padStart(2, '0')}`);
    // Sorts last, so a limit taken alphabetically would drop it.
    await backend.applySchema(crowded.store, names.map((table) => ({ kind: 'create_table', table })));
    await backend.applySchema(crowded.store, [{ kind: 'create_table', table: 'zebra' }]);
    const crowdedSource = sourceFor(crowded);
    const { tables, omittedTables } = ready(await crowdedSource.tables());
    await crowdedSource.close();
    expect(omittedTables).toBe(2);
    expect(tables).toHaveLength(40);
    expect(tables.map(({ name }) => name)).toContain('zebra');
    expect(tables.map(({ name }) => name)).not.toContain('t00');
    expect(tables.map(({ name }) => name)).toEqual(tables.map(({ name }) => name).sort());
  });

  it('sends no credentials to the browser', async () => {
    const text = JSON.stringify([await poll('/api/tables'), await poll('/api/tables/events')]);
    expect(text).not.toContain(account.readPassword);
    expect(text).not.toContain(config.dataDbPassword);
    expect(text).not.toContain(config.encryptionKey.toString('base64'));
    expect(text).not.toMatch(/password/i);
  });

  it('says so clearly when the account has no store', async () => {
    const missing = sourceFor({ slug: 'no-such-account' });
    expect(await missing.tables()).toMatchObject({
      state: 'no_store',
      message: expect.stringContaining('no-such-account'),
    });
    expect(await missing.events()).toEqual({ state: 'ready', events: [] });
    await missing.close();
  });

  it('hides why a read failed, including when the login cannot be opened', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrongKey = createTablesSource({
      appDatabaseUrl: config.appDatabaseUrl,
      encryptionKey: Buffer.alloc(32, 7),
      accountSlug: account.slug,
    });
    expect(await wrongKey.tables()).toEqual({ state: 'unavailable', message: expect.any(String) });
    await wrongKey.close();

    const closed = createTablesSource({
      appDatabaseUrl: 'postgres://nobody:not-the-password@localhost:1/sw_app',
      encryptionKey: config.encryptionKey,
      accountSlug: account.slug,
    });
    const response = await closed.events();
    expect(response.state).toBe('unavailable');
    expect(JSON.stringify(response)).not.toMatch(/not-the-password|nobody|ECONNREFUSED/);
    await closed.close();
    spy.mockRestore();
  });
});

describe('event progress', () => {
  const shape = (label: string) => `${label}-${randomBytes(4).toString('hex')}`;

  async function addEvent(fingerprint: string | null, source = ''): Promise<string> {
    const { rows } = await appDb.query<{ id: string }>(
      `INSERT INTO events (account_id, body, source, op, fingerprint, request)
       VALUES ($1, $2, $3, 'write', $4, '{}') RETURNING id`,
      [account.id, Buffer.from('{"private":"payload"}'), source, fingerprint],
    );
    return rows[0]!.id;
  }
  const addJob = (eventId: string, attempts = 0) =>
    appDb.query(`INSERT INTO queue (account_id, kind, event_id, attempts) VALUES ($1, 'ingest', $2, $3)`, [
      account.id,
      eventId,
      attempts,
    ]);
  const quarantine = (eventId: string, reason: string, detail: string | null = null, storeId: string | null = null) =>
    appDb.query(`INSERT INTO quarantine (event_id, account_id, reason, detail, store_id) VALUES ($1, $2, $3, $4, $5)`, [
      eventId,
      account.id,
      reason,
      detail,
      storeId,
    ]);
  const attempt = (fingerprint: string, status: string, detail: string | null = null, source = '') =>
    appDb.query(
      `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status, detail, finished_at)
       VALUES ($1, $2, 'write', $3, $4, $5, CASE WHEN $4 = 'running' THEN NULL ELSE now() END)`,
      [account.id, source, fingerprint, status, detail],
    );

  async function view(eventId: string): Promise<EventView> {
    const response = await poll<{ state: 'ready'; events: EventView[] }>('/api/tables/events');
    expect(response.state).toBe('ready');
    const event = response.events.find(({ id }) => id === eventId);
    if (!event) throw new Error(`No event ${eventId}`);
    return event;
  }

  it('calls a job in the queue queued, with its attempts', async () => {
    const fresh = await addEvent(shape('fp'));
    await addJob(fresh);
    expect(await view(fresh)).toMatchObject({ status: 'queued', attempts: 0 });

    const retrying = await addEvent(shape('fp'));
    await addJob(retrying, 3);
    expect(await view(retrying)).toMatchObject({ status: 'queued', attempts: 3 });
  });

  it('keeps showing an open failure while the job retries for another store', async () => {
    const eventId = await addEvent(shape('fp'));
    await addJob(eventId, 2);
    await quarantine(eventId, 'write_error', 'down', account.storeId);
    expect(await view(eventId)).toMatchObject({
      status: 'queued',
      attempts: 2,
      quarantine: [{ reason: 'write_error', detail: 'down' }],
    });
  });

  it('calls a job gone with nothing open written, and only then', async () => {
    const eventId = await addEvent(shape('fp'), 'shopify');
    await addJob(eventId);
    expect((await view(eventId)).status).toBe('queued');

    await appDb.query('DELETE FROM queue WHERE event_id = $1', [eventId]);
    expect(await view(eventId)).toMatchObject({ status: 'written', replayed: false, attempts: null, source: 'shopify' });
  });

  it('shows the reason for a malformed event, which never had a job', async () => {
    const eventId = await addEvent(null);
    await quarantine(eventId, 'malformed', 'Not an object or array');
    expect(await view(eventId)).toMatchObject({
      status: 'quarantined',
      quarantine: [{ reason: 'malformed', detail: 'Not an object or array' }],
    });
  });

  it('follows an unknown shape from waiting, through generating, to written by a replay', async () => {
    const fingerprint = shape('fp');
    const eventId = await addEvent(fingerprint);
    await quarantine(eventId, 'unknown_fingerprint', 'No active adapter');
    expect(await view(eventId)).toMatchObject({ status: 'waiting', adapterFailure: null });

    await attempt(fingerprint, 'running');
    expect((await view(eventId)).status).toBe('adapter_generating');

    await appDb.query(`UPDATE adapter_attempts SET status = 'failed', detail = 'LLM gave up' WHERE fingerprint = $1`, [fingerprint]);
    expect(await view(eventId)).toMatchObject({ status: 'waiting', adapterFailure: 'LLM gave up' });

    const { rows } = await appDb.query<{ id: string }>(
      `INSERT INTO adapters (account_id, op, fingerprint, version, code) VALUES ($1, 'write', $2, 1, '') RETURNING id`,
      [account.id, fingerprint],
    );
    await appDb.query('UPDATE quarantine SET released_at = now(), released_by_adapter_id = $2 WHERE event_id = $1', [
      eventId,
      rows[0]!.id,
    ]);
    expect(await view(eventId)).toMatchObject({ status: 'written', replayed: true, quarantine: [] });
  });

  it('does not match a generation for another source', async () => {
    const fingerprint = shape('fp');
    const eventId = await addEvent(fingerprint);
    await quarantine(eventId, 'unknown_fingerprint');
    await attempt(fingerprint, 'running', null, 'elsewhere');
    expect((await view(eventId)).status).toBe('waiting');
  });

  it('keeps a failure the generator leaves alone quarantined, even during a generation', async () => {
    const fingerprint = shape('fp');
    const eventId = await addEvent(fingerprint);
    await quarantine(eventId, 'write_error', 'disk full');
    await attempt(fingerprint, 'running');
    expect(await view(eventId)).toMatchObject({ status: 'quarantined', quarantine: [{ reason: 'write_error' }] });
  });

  it('lists every open row when an event failed against more than one store', async () => {
    const eventId = await addEvent(shape('fp'));
    await quarantine(eventId, 'adapter_error', 'threw', null);
    await quarantine(eventId, 'write_error', 'down', account.storeId);
    const event = await view(eventId);
    expect(event.status).toBe('quarantined');
    expect(event.quarantine.map(({ reason }) => reason).sort()).toEqual(['adapter_error', 'write_error']);
  });

  it('passes a detail holding HTML through untouched, and cuts a long one', async () => {
    const html = await addEvent(shape('fp'));
    await quarantine(html, 'adapter_error', '<script>alert(1)</script>');
    expect((await view(html)).quarantine[0]!.detail).toBe('<script>alert(1)</script>');

    const long = await addEvent(shape('fp'));
    await quarantine(long, 'adapter_error', 'd'.repeat(1000));
    expect((await view(long)).quarantine[0]!.detail).toHaveLength(300);
  });

  it('sends no payloads or request headers, and only this account\'s events', async () => {
    const theirs = await appDb.query<{ id: string }>(
      `INSERT INTO events (account_id, body, source, op, fingerprint, request)
       VALUES ($1, 'x', '', 'write', 'theirs', '{}') RETURNING id`,
      [other.id],
    );
    const eventId = await addEvent(shape('fp'));
    const response = await poll<{ events: EventView[] }>('/api/tables/events');
    const text = JSON.stringify(response);
    expect(text).toContain(eventId);
    expect(text).not.toContain(theirs.rows[0]!.id);
    expect(text).not.toContain('private');
    expect(Object.keys(response.events[0]!)).not.toEqual(expect.arrayContaining(['body']));
    expect(Object.keys(response.events[0]!)).not.toEqual(expect.arrayContaining(['request']));
  });

  it('shows the most recent events, newest first', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 14; index += 1) ids.push(await addEvent(shape('fp')));
    const { events } = await poll<{ events: EventView[] }>('/api/tables/events');
    expect(events.map(({ id }) => id)).toEqual(ids.slice(-12).reverse());
  });
});

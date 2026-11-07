import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StorageError } from '../src/contracts/index.js';
import type { LogicalType, StoreConfig, TableRow } from '../src/contracts/index.js';
import { isRetryable } from '../src/storage/postgres/errors.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';

const dataUrl = new URL(loadConfig().dataDatabaseUrl);
const connection = {
  host: dataUrl.hostname,
  port: Number(dataUrl.port),
  database: dataUrl.pathname.slice(1),
};
const credentials = {
  user: decodeURIComponent(dataUrl.username),
  password: decodeURIComponent(dataUrl.password),
};

// Every store here has its own database, and creating that many takes a while.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });

// Tests create far more stores than a server has connections, so idle ones close at once.
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const admin = new pg.Client({ ...connection, ...credentials });
const scratch: string[] = [];

/** Runs `run` as the platform role, in the store's own database. */
async function inStore<T>(store: StoreConfig, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...connection, ...credentials, database: store.namespace });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** A store in its own scratch database, removed after the suite. */
function newStore(label = 'store'): StoreConfig {
  const namespace = `t_${randomBytes(6).toString('hex')}_${label}`;
  scratch.push(namespace);
  return { namespace, connection, credentials };
}

async function tableStore(table = 'item', columns: Record<string, LogicalType> = {}) {
  const store = newStore();
  await backend.provision(store);
  await backend.applySchema(store, [
    { kind: 'create_table', table },
    ...Object.entries(columns).map(([column, type]) => ({
      kind: 'add_column' as const,
      table,
      column,
      type,
    })),
  ]);
  return store;
}

async function readRow(store: StoreConfig, table: string, id: string) {
  const result = await inStore(store, (client) =>
    client.query(
      `SELECT *, "_event_seq"::text AS "_event_seq" FROM ${pg.escapeIdentifier(table)}
       WHERE "id" = $1`,
      [id],
    ),
  );
  return result.rows[0];
}

async function asLogin<T>(
  login: Record<string, unknown>,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    ...connection,
    user: login.user as string,
    password: login.password as string,
    database: login.database as string,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function failure(promise: Promise<unknown>): Promise<StorageError> {
  const error = await promise.then(
    () => {
      throw new Error('Expected a StorageError, but the call succeeded');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(StorageError);
  return error as StorageError;
}

beforeAll(async () => {
  await admin.connect();
});

afterAll(async () => {
  await backend.close();
  for (const namespace of scratch) {
    // Dropping the database removes the grants that would otherwise block dropping the role.
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
  await admin.end();
});

describe('capabilities', () => {
  it('reports atomic writes and immediate idempotency', () => {
    expect(backend.capabilities).toEqual({ atomicWrites: true, idempotency: 'immediate' });
  });
});

describe('provision', () => {
  it('returns a login that can read the store', async () => {
    const store = await tableStore('item', { name: 'string' });
    const login = await backend.provision(store);
    await backend.write(store, [
      {
        table: 'item',
        columns: { name: 'string' },
        rows: [{ id: 'a', _event_seq: '1', name: 'first' }],
      },
    ]);

    const rows = await asLogin(login, async (client) => {
      const result = await client.query('SELECT "id", "name" FROM "item"');
      return result.rows;
    });
    expect(rows).toEqual([{ id: 'a', name: 'first' }]);
  });

  it('can be repeated, and the newest credentials work', async () => {
    const store = newStore();
    const first = await backend.provision(store);
    await backend.applySchema(store, [{ kind: 'create_table', table: 'item' }]);
    const second = await backend.provision(store);

    expect(second.user).toBe(first.user);
    await asLogin(second, (client) => client.query('SELECT * FROM "item"'));
    await expect(asLogin(first, async () => undefined)).rejects.toMatchObject({ code: '28P01' });
  });

  it('keeps reading tables and columns added after provisioning', async () => {
    const store = newStore();
    const login = await backend.provision(store);
    await backend.applySchema(store, [
      { kind: 'create_table', table: 'later' },
      { kind: 'add_column', table: 'later', column: 'first_col', type: 'string' },
    ]);
    await backend.write(store, [
      {
        table: 'later',
        columns: { first_col: 'string' },
        rows: [{ id: 'a', _event_seq: '1', first_col: 'x' }],
      },
    ]);
    await backend.applySchema(store, [
      { kind: 'add_column', table: 'later', column: 'second_col', type: 'string' },
    ]);

    const rows = await asLogin(login, async (client) => {
      const result = await client.query('SELECT "first_col", "second_col" FROM "later"');
      return result.rows;
    });
    expect(rows).toEqual([{ first_col: 'x', second_col: null }]);
  });

  it('stops the login writing, even with read-only mode switched off', async () => {
    const store = await tableStore('item', { name: 'string' });
    const login = await backend.provision(store);
    await backend.write(store, [
      {
        table: 'item',
        columns: { name: 'string' },
        rows: [{ id: 'a', _event_seq: '1', name: 'keep' }],
      },
    ]);

    await asLogin(login, async (client) => {
      await client.query('SET default_transaction_read_only = off');
      for (const statement of [
        `INSERT INTO "item" ("id", "_event_seq") VALUES ('b', 1)`,
        `UPDATE "item" SET "name" = 'changed'`,
        `DELETE FROM "item"`,
        `TRUNCATE "item"`,
        `DROP TABLE "item"`,
        `ALTER TABLE "item" ADD COLUMN "extra" TEXT`,
        `CREATE TABLE "made_up" ("id" TEXT)`,
        `CREATE TEMP TABLE "scratch" ("id" TEXT)`,
      ]) {
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      }
    });
    expect(await readRow(store, 'item', 'a')).toMatchObject({ name: 'keep' });
  });

  it('stops the login reading another store', async () => {
    const mine = await tableStore();
    const other = await tableStore('secret', { value: 'string' });
    const login = await backend.provision(mine);

    // Not even a connection, to the other store or any platform database.
    for (const database of [other.namespace, connection.database, 'sw_app', 'postgres', 'template1']) {
      await expect(
        asLogin({ ...login, database }, async () => undefined),
        database,
      ).rejects.toMatchObject({ code: '42501' });
    }

    await asLogin(login, async (client) => {
      const table = `${pg.escapeIdentifier(other.namespace)}."public"."secret"`;
      await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '0A000' });

      // Per-database catalogs don't list another store's tables.
      const listed = await client.query(`SELECT 1 FROM pg_class WHERE relname = 'secret'`);
      expect(listed.rowCount).toBe(0);
    });
  });

  it('returns the database the login connects to', async () => {
    const store = newStore();
    const login = await backend.provision(store);
    expect(login.database).toBe(store.namespace);
    const current = await asLogin(login, async (client) => {
      const result = await client.query('SELECT current_database() AS name');
      return result.rows[0].name;
    });
    expect(current).toBe(store.namespace);
  });

  it('gives the login a statement timeout and limits its role', async () => {
    const store = newStore();
    const login = await backend.provision(store);

    const timeout = await asLogin(login, async (client) => {
      const result = await client.query('SHOW statement_timeout');
      return result.rows[0].statement_timeout;
    });
    expect(timeout).toBe('30s');

    const role = await admin.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
      [login.user],
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });
  });

  it('refuses a login past its connection limit, without affecting the platform', async () => {
    const store = newStore();
    await backend.provision(store);
    const login = await backend.provision(store);

    const open: pg.Client[] = [];
    try {
      for (let count = 0; count < 10; count += 1) {
        const client = new pg.Client({
          ...connection,
          user: login.user as string,
          password: login.password as string,
          database: login.database as string,
        });
        await client.connect();
        open.push(client);
      }
      await expect(asLogin(login, async () => undefined)).rejects.toMatchObject({ code: '53300' });
      await expect(backend.health(store)).resolves.toBeUndefined();
    } finally {
      await Promise.all(open.map((client) => client.end()));
    }
  });

  it('bounds the role name for a long namespace', async () => {
    const long = `t_${randomBytes(6).toString('hex')}_${'n'.repeat(48)}`;
    expect(long).toHaveLength(63);
    scratch.push(long);
    const store = { namespace: long, connection, credentials };

    const login = await backend.provision(store);
    expect(Buffer.byteLength(login.user as string)).toBeLessThanOrEqual(63);
    await asLogin(login, (client) => client.query('SELECT 1'));
  });

  it('handles concurrent calls for different stores and the same store', async () => {
    const stores = Array.from({ length: 6 }, () => newStore());
    const logins = await Promise.all(stores.map((store) => backend.provision(store)));
    await Promise.all(logins.map((login) => asLogin(login, (client) => client.query('SELECT 1'))));

    const shared = newStore();
    await Promise.all([backend.provision(shared), backend.provision(shared)]);
    const final = await backend.provision(shared);
    await asLogin(final, (client) => client.query('SELECT 1'));
  });

  // The race is on the GRANTs after the database exists, and only sometimes loses, so it needs several tries.
  it('never fails with concurrently updated catalog rows when calls for one store overlap', async () => {
    for (let round = 0; round < 8; round += 1) {
      const store = newStore();
      await expect(
        Promise.all([backend.provision(store), backend.provision(store), backend.provision(store)]),
      ).resolves.toHaveLength(3);
    }
  });
});

describe('applySchema', () => {
  async function columnsOf(store: StoreConfig, table: string) {
    const result = await inStore(store, (client) =>
      client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      ),
    );
    return Object.fromEntries(result.rows.map((row) => [row.column_name, row.data_type]));
  }

  async function indexesOf(store: StoreConfig, table: string): Promise<string[]> {
    const result = await inStore(store, (client) =>
      client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`, [
        table,
      ]),
    );
    return result.rows.map((row) => row.indexdef);
  }

  it('creates id and the platform columns, and maps every logical type', async () => {
    const store = await tableStore('item', {
      s: 'string',
      n: 'number',
      b: 'boolean',
      t: 'timestamp',
      j: 'json',
    });
    expect(await columnsOf(store, 'item')).toEqual({
      id: 'text',
      _event_seq: 'bigint',
      _deleted_at: 'timestamp with time zone',
      s: 'text',
      n: 'numeric',
      b: 'boolean',
      t: 'timestamp with time zone',
      j: 'jsonb',
    });
  });

  it('can be repeated without changing data, indexes, or an existing column type', async () => {
    const store = await tableStore('item', { name: 'string' });
    const changes = [
      { kind: 'create_table', table: 'item' },
      { kind: 'add_column', table: 'item', column: 'name', type: 'number' },
      { kind: 'add_index', table: 'item', column: 'name' },
    ] as const;
    await backend.write(store, [
      {
        table: 'item',
        columns: { name: 'string' },
        rows: [{ id: 'a', _event_seq: '1', name: 'keep' }],
      },
    ]);

    await backend.applySchema(store, [...changes]);
    const indexes = await indexesOf(store, 'item');
    await backend.applySchema(store, [...changes]);

    expect(await indexesOf(store, 'item')).toEqual(indexes);
    expect((await columnsOf(store, 'item')).name).toBe('text');
    expect(await readRow(store, 'item', 'a')).toMatchObject({ name: 'keep' });
  });

  it('adds a column to a populated table', async () => {
    const store = await tableStore('item', { name: 'string' });
    await backend.write(store, [
      {
        table: 'item',
        columns: { name: 'string' },
        rows: [{ id: 'a', _event_seq: '1', name: 'x' }],
      },
    ]);
    await backend.applySchema(store, [
      { kind: 'add_column', table: 'item', column: 'extra', type: 'number' },
    ]);
    expect(await readRow(store, 'item', 'a')).toMatchObject({ name: 'x', extra: null });
  });

  it('keeps index names apart when the table and column split differently', async () => {
    const store = await tableStore('a_b', { c: 'string' });
    await backend.applySchema(store, [
      { kind: 'create_table', table: 'a' },
      { kind: 'add_column', table: 'a', column: 'b_c', type: 'string' },
      { kind: 'add_index', table: 'a_b', column: 'c' },
      { kind: 'add_index', table: 'a', column: 'b_c' },
    ]);
    // The primary key plus the new index, on each table.
    expect(await indexesOf(store, 'a_b')).toHaveLength(2);
    expect(await indexesOf(store, 'a')).toHaveLength(2);
  });

  it('keeps index names apart when 63-byte names share a long prefix', async () => {
    const prefix = 'x'.repeat(62);
    const store = await tableStore(`${prefix}1`, { [`${prefix}a`]: 'string', [`${prefix}b`]: 'string' });
    await backend.applySchema(store, [
      { kind: 'add_index', table: `${prefix}1`, column: `${prefix}a` },
      { kind: 'add_index', table: `${prefix}1`, column: `${prefix}b` },
    ]);
    expect(await indexesOf(store, `${prefix}1`)).toHaveLength(3);
  });

  it('creates a table whose name matches another table primary key default', async () => {
    const store = await tableStore('foo');
    await backend.applySchema(store, [{ kind: 'create_table', table: 'foo_pkey' }]);
    expect(await columnsOf(store, 'foo_pkey')).toHaveProperty('_event_seq');
  });

  it('classifies a change to a missing table as permanent', async () => {
    const store = await tableStore();
    const error = await failure(
      backend.applySchema(store, [
        { kind: 'add_column', table: 'missing', column: 'x', type: 'string' },
      ]),
    );
    expect(error.retryable).toBe(false);
  });

  it('commits each change separately, so a retry finishes the rest', async () => {
    const store = await tableStore();
    const fixed = { kind: 'create_table', table: 'later' } as const;
    await failure(
      backend.applySchema(store, [
        { kind: 'create_table', table: 'committed' },
        { kind: 'add_column', table: 'later', column: 'x', type: 'string' },
      ]),
    );
    expect(await columnsOf(store, 'committed')).toHaveProperty('id');

    await backend.applySchema(store, [
      { kind: 'create_table', table: 'committed' },
      fixed,
      { kind: 'add_column', table: 'later', column: 'x', type: 'string' },
    ]);
    expect(await columnsOf(store, 'later')).toHaveProperty('x');
  });

  it('gives up on a held table lock with a retryable error', { timeout: 15_000 }, async () => {
    const store = await tableStore();
    const holder = new pg.Client({ ...connection, ...credentials, database: store.namespace });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "item"');
      const started = Date.now();
      const errors = await Promise.all([
        failure(
          backend.applySchema(store, [
            { kind: 'add_column', table: 'item', column: 'x', type: 'string' },
          ]),
        ),
        failure(backend.applySchema(store, [{ kind: 'add_index', table: 'item', column: 'id' }])),
      ]);
      for (const error of errors) expect(error.retryable).toBe(true);
      // The 5s lock timeout, not the 10-minute DDL statement timeout.
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  it('settles overlapping calls as success or a retryable error', async () => {
    const store = newStore();
    await backend.provision(store);
    const change = [
      { kind: 'create_table', table: 'race' },
      { kind: 'add_column', table: 'race', column: 'x', type: 'string' },
      { kind: 'add_index', table: 'race', column: 'x' },
    ] as const;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => backend.applySchema(store, [...change])),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(StorageError);
        expect(result.reason.retryable).toBe(true);
      }
    }
    await backend.applySchema(store, [...change]);
    expect(await columnsOf(store, 'race')).toHaveProperty('x');
  });
});

describe('write', () => {
  const columns: Record<string, LogicalType> = { a: 'string', b: 'string' };

  async function put(store: StoreConfig, ...rows: TableRow[]) {
    await backend.write(store, [{ table: 'item', columns, rows }]);
  }

  const deletedAt = '2026-01-02T03:04:05.000Z';
  const stamp = new Date(deletedAt);

  describe('merging', () => {
    it('writing the same row twice leaves one row', async () => {
      const store = await tableStore('item', columns);
      const row = { id: 'r', _event_seq: '5', a: 'x' };
      await put(store, row);
      await put(store, row);

      const count = await inStore(store, (client) =>
        client.query('SELECT count(*)::int AS n FROM "item"'),
      );
      expect(count.rows[0].n).toBe(1);
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'x', _event_seq: '5' });
    });

    it('lets a higher write replace included columns and keep absent ones', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '1', a: 'old-a', b: 'old-b' });
      await put(store, { id: 'r', _event_seq: '2', a: 'new-a' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'new-a',
        b: 'old-b',
        _event_seq: '2',
      });
    });

    it('lets an equal write replace included columns', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '2', a: 'first' });
      await put(store, { id: 'r', _event_seq: '2', a: 'second' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'second', _event_seq: '2' });
    });

    it('lets an explicit null clear a column at or above the row seq', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '1', a: 'x', b: 'y' });
      await put(store, { id: 'r', _event_seq: '2', a: null });
      await put(store, { id: 'r', _event_seq: '2', b: undefined });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: null, b: null });
    });

    it('lets a lower write fill only NULL columns and keep the higher seq', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', a: 'newer' });
      await put(store, { id: 'r', _event_seq: '3', a: 'older', b: 'filled' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'newer',
        b: 'filled',
        _event_seq: '10',
      });
    });

    it('stops a lower null clearing a newer value', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', a: 'newer' });
      await put(store, { id: 'r', _event_seq: '3', a: null });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'newer', _event_seq: '10' });
    });

    it('converges in any order when no two lower writes compete for a column', async () => {
      const writes: TableRow[] = [
        { id: 'r', _event_seq: '1', a: 'a1' },
        { id: 'r', _event_seq: '2', b: 'b2' },
        { id: 'r', _event_seq: '3', a: 'a3' },
      ];
      const results = [];
      for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1], [2, 0, 1], [1, 0, 2]]) {
        const store = await tableStore('item', columns);
        for (const index of order) await put(store, writes[index]!);
        const { a, b, _event_seq } = await readRow(store, 'item', 'r');
        results.push({ a, b, _event_seq });
      }
      for (const result of results) {
        expect(result).toEqual({ a: 'a3', b: 'b2', _event_seq: '3' });
      }
    });

    // The limit the §11.2 MVP option accepts: a rebuild, which runs in order, corrects it.
    it('keeps the first lower write to fill a NULL, even if a later one has a higher seq', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '3', b: 'b3' });
      await put(store, { id: 'r', _event_seq: '1', a: 'a1' });
      await put(store, { id: 'r', _event_seq: '2', a: 'a2' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'a1', b: 'b3', _event_seq: '3' });
    });

    it('lets a lower write refill a column a newer write cleared', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '3', a: null });
      await put(store, { id: 'r', _event_seq: '1', a: 'a1' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'a1', _event_seq: '3' });
    });

    it('compares seq numerically and past 2^53', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', a: 'ten' });
      await put(store, { id: 'r', _event_seq: '9', a: 'nine' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'ten', _event_seq: '10' });

      await put(store, { id: 'big', _event_seq: '9007199254740993', a: 'higher' });
      await put(store, { id: 'big', _event_seq: '9007199254740992', a: 'lower' });
      expect(await readRow(store, 'item', 'big')).toMatchObject({
        a: 'higher',
        _event_seq: '9007199254740993',
      });
    });

    it('applies repeated ids within one event in order', async () => {
      const store = await tableStore('item', columns);
      await put(
        store,
        { id: 'r', _event_seq: '1', a: 'first' },
        { id: 'r', _event_seq: '1', a: 'second' },
      );
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'second' });
    });

    it('updates the seq and deletion for a row with no data columns', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '1', a: 'x' });
      await put(store, { id: 'r', _event_seq: '2', _deleted_at: deletedAt });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'x',
        _event_seq: '2',
        _deleted_at: stamp,
      });
    });
  });

  describe('_deleted_at', () => {
    it('creates a deleted row when a delete arrives first', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        _deleted_at: stamp,
        _event_seq: '5',
      });
    });

    it('keeps included fields from the deleting event', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '1', a: 'x', b: 'y' });
      await put(store, { id: 'r', _event_seq: '2', _deleted_at: deletedAt, a: 'final' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'final',
        b: 'y',
        _deleted_at: stamp,
        _event_seq: '2',
      });
    });

    it('is cleared by a newer write that leaves it out', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      await put(store, { id: 'r', _event_seq: '6', a: 'back' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'back',
        _deleted_at: null,
        _event_seq: '6',
      });
    });

    it('is cleared by an equal write that leaves it out', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      await put(store, { id: 'r', _event_seq: '5', a: 'same-seq' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ _deleted_at: null });
    });

    it('is set by an equal write that includes it', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '5', a: 'x' });
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ _deleted_at: stamp, a: 'x' });
    });

    it('is replaced by a newer delete', async () => {
      const store = await tableStore('item', columns);
      const later = '2026-02-01T00:00:00.000Z';
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      await put(store, { id: 'r', _event_seq: '6', _deleted_at: later });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ _deleted_at: new Date(later) });
    });

    it('stops a delayed delete marking a newer live row deleted', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', a: 'live' });
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'live',
        _deleted_at: null,
        _event_seq: '10',
      });
    });

    it('lets a delayed delete fill NULL columns but stay undeleted', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', a: 'live' });
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: deletedAt, a: 'old', b: 'filled' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'live',
        b: 'filled',
        _deleted_at: null,
        _event_seq: '10',
      });
    });

    it('stops a delayed write restoring a newer delete', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', _deleted_at: deletedAt });
      await put(store, { id: 'r', _event_seq: '5', a: 'late' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        a: 'late',
        _deleted_at: stamp,
        _event_seq: '10',
      });
    });

    it('stops a delayed delete replacing a newer delete time', async () => {
      const store = await tableStore('item', columns);
      await put(store, { id: 'r', _event_seq: '10', _deleted_at: deletedAt });
      await put(store, { id: 'r', _event_seq: '5', _deleted_at: '2020-01-01T00:00:00.000Z' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ _deleted_at: stamp });
    });

    it('ends in the same state whichever order a write and delete arrive', async () => {
      const write = { id: 'r', _event_seq: '1', a: 'x' };
      const del = { id: 'r', _event_seq: '2', _deleted_at: deletedAt };

      const inOrder = await tableStore('item', columns);
      await put(inOrder, write);
      await put(inOrder, del);
      const reversed = await tableStore('item', columns);
      await put(reversed, del);
      await put(reversed, write);

      expect(await readRow(reversed, 'item', 'r')).toEqual(await readRow(inOrder, 'item', 'r'));
      expect(await readRow(reversed, 'item', 'r')).toMatchObject({
        a: 'x',
        _deleted_at: stamp,
        _event_seq: '2',
      });
    });

    it('restores only for a write later than the delete, in any order', async () => {
      const write = { id: 'r', _event_seq: '3', a: 'back' };
      const del = { id: 'r', _event_seq: '2', _deleted_at: deletedAt };

      const reversed = await tableStore('item', columns);
      await put(reversed, write);
      await put(reversed, del);
      expect(await readRow(reversed, 'item', 'r')).toMatchObject({
        _deleted_at: null,
        _event_seq: '3',
      });
    });
  });

  describe('identifiers and values', () => {
    it('handles reserved words and awkward names as tables and columns', async () => {
      for (const table of ['user', 'order', 'select', 'excluded', 'table']) {
        const names: Record<string, LogicalType> = {
          group: 'string',
          select: 'number',
          constructor: 'string' as LogicalType,
          excluded: 'string',
        };
        const store = await tableStore(table, names);
        await backend.applySchema(store, [{ kind: 'add_index', table, column: 'group' }]);
        const write = {
          table,
          columns: names,
          rows: [{ id: 'r', _event_seq: '1', group: 'g', select: 1, constructor: 'c', excluded: 'e' }],
        };
        await backend.write(store, [write]);
        await backend.write(store, [write]);
        expect(await readRow(store, table, 'r')).toMatchObject({
          group: 'g',
          select: '1',
          constructor: 'c',
          excluded: 'e',
        });
      }
    });

    it('binds values, so SQL in a value is only text', async () => {
      const store = await tableStore('item', columns);
      const value = `'); DROP TABLE "item"; --`;
      await put(store, { id: value, _event_seq: '1', a: value });
      expect(await readRow(store, 'item', value)).toMatchObject({ a: value });
    });

    it('stores every logical type and clears each with null', async () => {
      const types: Record<string, LogicalType> = {
        s: 'string',
        n: 'number',
        b: 'boolean',
        t: 'timestamp',
        o: 'json',
        l: 'json',
        js: 'json',
        jn: 'json',
        jf: 'json',
      };
      const store = await tableStore('item', types);
      const write = (seq: string, row: Record<string, unknown>) =>
        backend.write(store, [
          { table: 'item', columns: types, rows: [{ id: 'r', _event_seq: seq, ...row }] },
        ]);

      await write('1', {
        s: 'text',
        n: 100.5,
        b: false,
        t: '2026-03-04T05:06:07+02:00',
        o: { nested: [1, { two: true }] },
        l: [1, 'two', null],
        js: 'a json string',
        jn: 0,
        jf: false,
      });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        s: 'text',
        n: '100.5',
        b: false,
        t: new Date('2026-03-04T03:06:07Z'),
        o: { nested: [1, { two: true }] },
        l: [1, 'two', null],
        js: 'a json string',
        jn: 0,
        jf: false,
      });

      await write('2', { s: null, n: null, b: null, t: null, o: null, l: null, js: null, jn: null, jf: null });
      expect(await readRow(store, 'item', 'r')).toMatchObject({
        s: null,
        n: null,
        b: null,
        t: null,
        o: null,
        l: null,
        js: null,
        jn: null,
        jf: null,
      });
    });

    it('fills a NULL false or zero correctly, without treating them as NULL', async () => {
      const types: Record<string, LogicalType> = { b: 'boolean', n: 'number', j: 'json' };
      const store = await tableStore('item', types);
      await backend.write(store, [
        { table: 'item', columns: types, rows: [{ id: 'r', _event_seq: '5', b: false, n: 0, j: 0 }] },
      ]);
      await backend.write(store, [
        { table: 'item', columns: types, rows: [{ id: 'r', _event_seq: '1', b: true, n: 9, j: 9 }] },
      ]);
      expect(await readRow(store, 'item', 'r')).toMatchObject({ b: false, n: '0', j: 0 });
    });
  });

  describe('failures', () => {
    /** Runs `check` while another connection holds an uncommitted insert of row `r`. */
    async function withRowLocked(store: StoreConfig, check: () => Promise<void>) {
      const holder = new pg.Client({ ...connection, ...credentials, database: store.namespace });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`INSERT INTO "item" ("id", "_event_seq") VALUES ('r', 1)`);
        await check();
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
    }

    it('returns a retryable error, not a crash, when the connection dies mid-event', async () => {
      const store = await tableStore('item', columns);
      await withRowLocked(store, async () => {
        const blocked = failure(put(store, { id: 'r', _event_seq: '2', a: 'x' }));

        let killed = 0;
        for (let attempt = 0; attempt < 100 && killed === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const result = await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = $1`,
            [store.namespace],
          );
          killed = result.rowCount ?? 0;
        }
        expect(killed).toBe(1);
        expect((await blocked).retryable).toBe(true);
      });

      // The pool replaced the dead connection.
      await put(store, { id: 'r', _event_seq: '2', a: 'x' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'x' });
    });

    it('gives up on a blocked write with a retryable error', async () => {
      const store = await tableStore('item', columns);
      const impatient = new PostgresBackend({ statementTimeoutMs: 300 });
      try {
        await withRowLocked(store, async () => {
          const error = await failure(
            impatient.write(store, [
              { table: 'item', columns, rows: [{ id: 'r', _event_seq: '2', a: 'x' }] },
            ]),
          );
          expect(error.retryable).toBe(true);
        });
      } finally {
        await impatient.close();
      }
    });

    it('rolls back the whole event when a later table fails', async () => {
      const store = await tableStore('item', columns);
      const error = await failure(
        backend.write(store, [
          { table: 'item', columns, rows: [{ id: 'r', _event_seq: '1', a: 'x' }] },
          { table: 'missing', columns: {}, rows: [{ id: 'r', _event_seq: '1' }] },
        ]),
      );
      expect(error.retryable).toBe(false);
      expect(await readRow(store, 'item', 'r')).toBeUndefined();
    });

    it('leaves the connection usable after a failed event', async () => {
      const store = await tableStore('item', columns);
      await failure(put(store, { id: 'r', _event_seq: 'not-a-number', a: 'x' }));
      await put(store, { id: 'r', _event_seq: '1', a: 'x' });
      expect(await readRow(store, 'item', 'r')).toMatchObject({ a: 'x' });
    });

    it.each([
      ['a NUL byte in text', { id: 'r', _event_seq: '1', a: 'bad\u0000text' }],
      ['an invalid seq', { id: 'r', _event_seq: 'not-a-number' }],
      ['a seq over BIGINT', { id: 'r', _event_seq: '9223372036854775808' }],
      ['an invalid deletion time', { id: 'r', _event_seq: '1', _deleted_at: 'yesterday-ish' }],
      ['an undeclared column', { id: 'r', _event_seq: '1', nope: 'x' }],
      ['an undeclared column set to null', { id: 'r', _event_seq: '1', nope: null }],
    ])('classifies %s as permanent', async (_label, row) => {
      const store = await tableStore('item', columns);
      const error = await failure(put(store, row as TableRow));
      expect(error.retryable).toBe(false);
    });

    it('classifies a declared column missing from the table as permanent', async () => {
      const store = await tableStore('item', columns);
      const error = await failure(
        backend.write(store, [
          { table: 'item', columns: { gone: 'string' }, rows: [{ id: 'r', _event_seq: '1', gone: 'x' }] },
        ]),
      );
      expect(error.retryable).toBe(false);
    });

    it('classifies a value that does not fit the column type as permanent', async () => {
      const types: Record<string, LogicalType> = { n: 'number' };
      const store = await tableStore('item', types);
      const error = await failure(
        backend.write(store, [
          { table: 'item', columns: types, rows: [{ id: 'r', _event_seq: '1', n: 'abc' }] },
        ]),
      );
      expect(error.retryable).toBe(false);
    });

    it('classifies a value JSON cannot serialize as permanent', async () => {
      const types: Record<string, LogicalType> = { j: 'json' };
      const store = await tableStore('item', types);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const error = await failure(
        backend.write(store, [
          { table: 'item', columns: types, rows: [{ id: 'r', _event_seq: '1', j: circular }] },
        ]),
      );
      expect(error.retryable).toBe(false);
    });

    it('classifies an unreachable server as retryable', async () => {
      const closedPort = { ...connection, port: 1 };
      const store = { namespace: 'unused', connection: closedPort, credentials };
      const separate = new PostgresBackend();
      try {
        for (const attempt of [
          () => separate.write(store, [{ table: 't', columns: {}, rows: [{ id: 'r', _event_seq: '1' }] }]),
          () => separate.applySchema(store, [{ kind: 'create_table', table: 't' }]),
          () => separate.health(store),
        ]) {
          expect((await failure(attempt())).retryable).toBe(true);
        }
      } finally {
        await separate.close();
      }
    });

    it('classifies a rejected password as retryable', async () => {
      const store = {
        namespace: 'unused',
        connection,
        credentials: { user: credentials.user, password: 'wrong' },
      };
      const separate = new PostgresBackend();
      try {
        const error = await failure(separate.applySchema(store, [{ kind: 'create_table', table: 't' }]));
        expect(error.retryable).toBe(true);
      } finally {
        await separate.close();
      }
    });

    it('classifies a store with no database as permanent', async () => {
      const store = { namespace: 'no_such_store', connection, credentials };
      const error = await failure(
        backend.write(store, [{ table: 't', columns: {}, rows: [{ id: 'r', _event_seq: '1' }] }]),
      );
      expect(error.retryable).toBe(false);
    });

    it('classifies incomplete store settings as permanent', async () => {
      const store = { namespace: 'unused', connection: {} };
      const error = await failure(backend.applySchema(store, [{ kind: 'create_table', table: 't' }]));
      expect(error.retryable).toBe(false);
    });

    it('treats an empty event as a no-op', async () => {
      const store = { namespace: 'unused', connection: {} };
      await backend.write(store, []);
      await backend.write(store, [{ table: 't', columns: {}, rows: [] }]);
      await backend.applySchema(store, []);
    });
  });
});

describe('health', () => {
  it('passes for a provisioned store', async () => {
    const store = newStore();
    await backend.provision(store);
    await expect(backend.health(store)).resolves.toBeUndefined();
  });

  it('fails permanently when the database is missing', async () => {
    const error = await failure(backend.health({ namespace: 'no_such_store', connection, credentials }));
    expect(error.retryable).toBe(false);
  });
});

describe('error classification', () => {
  function databaseError(code: string): pg.DatabaseError {
    const error = new pg.DatabaseError('boom', 0, 'error');
    error.code = code;
    return error;
  }

  it.each([
    ['40P01', 'deadlock'],
    ['40001', 'serialization failure'],
    ['53300', 'too many connections'],
    ['57014', 'statement timeout'],
    ['57P01', 'server shutting down'],
    ['55P03', 'lock timeout'],
    ['08006', 'connection failure'],
    ['28P01', 'bad password'],
    ['42501', 'revoked privilege'],
    ['XX000', 'internal error'],
  ])('treats %s (%s) as retryable', (code) => {
    expect(isRetryable(databaseError(code))).toBe(true);
  });

  it.each([
    ['22021', 'NUL byte'],
    ['22P02', 'bad number'],
    ['22003', 'out of range'],
    ['23502', 'not null'],
    ['42P01', 'missing table'],
    ['42703', 'missing column'],
    ['3D000', 'missing database'],
    ['3F000', 'missing schema'],
    ['54011', 'too many columns'],
  ])('treats %s (%s) as permanent', (code) => {
    expect(isRetryable(databaseError(code))).toBe(false);
  });

  it('treats overlapping DDL as retryable only for DDL', () => {
    expect(isRetryable(databaseError('23505'), { ddl: true })).toBe(true);
    expect(isRetryable(databaseError('23505'))).toBe(false);
  });

  it('treats network-style errors as retryable and serialization errors as permanent', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isRetryable(reset)).toBe(true);
    expect(isRetryable(pipe)).toBe(true);
    expect(isRetryable(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryable(new TypeError('circular'))).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// These tests migrate a scratch schema, not the real one, so running the down migration can't
// disturb other test files. The migration count stays fixed so that later migrations can change
// the schema without invalidating what this file says about 0002.
const MIGRATIONS_THROUGH_APP_SCHEMA = 2;

const config = loadConfig();
const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
const client = new pg.Client({ connectionString: config.appDatabaseUrl });

function migrate(direction: 'up' | 'down', count: number) {
  return runner({
    databaseUrl: config.appDatabaseUrl,
    dir: fileURLToPath(new URL('../migrations/app', import.meta.url)),
    migrationsTable: 'schema_migrations',
    schema,
    createSchema: true,
    noLock: true,
    direction,
    count,
    log: () => undefined,
  });
}

async function listTables(): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name <> 'schema_migrations'
     ORDER BY table_name`,
    [schema],
  );
  return result.rows.map((row) => row.table_name);
}

const EXPECTED_COLUMNS: Record<string, string[]> = {
  accounts: ['id', 'slug', 'active_store_id', 'auto_activate', 'status', 'created_at'],
  account_stores: [
    'id',
    'account_id',
    'generation',
    'backend',
    'connection',
    'credentials',
    'read_credentials',
    'namespace',
    'status',
    'rebuild_through_seq',
    'rebuild_cursor',
    'created_at',
  ],
  api_keys: ['id', 'account_id', 'key_hash', 'created_at', 'revoked_at'],
  adapters: [
    'id',
    'account_id',
    'source',
    'op',
    'fingerprint',
    'opaque_paths',
    'version',
    'code',
    'active',
    'created_at',
  ],
  adapter_fingerprints: ['adapter_id', 'fingerprint', 'created_at'],
  events: [
    'id',
    'seq',
    'account_id',
    'body',
    'source',
    'op',
    'fingerprint',
    'idempotency_key',
    'request',
    'received_at',
  ],
  queue: [
    'id',
    'account_id',
    'kind',
    'event_id',
    'adapter_id',
    'store_id',
    'run_at',
    'attempts',
    'created_at',
  ],
  quarantine: [
    'id',
    'event_id',
    'account_id',
    'store_id',
    'reason',
    'detail',
    'quarantined_at',
    'released_at',
    'released_by_adapter_id',
  ],
  replay_log: ['id', 'quarantine_id', 'adapter_id', 'status', 'detail', 'attempted_at'],
  adapter_attempts: [
    'id',
    'account_id',
    'source',
    'op',
    'fingerprint',
    'status',
    'adapter_id',
    'detail',
    'started_at',
    'finished_at',
  ],
  data_columns: ['store_id', 'table_name', 'column_name', 'logical_type', 'created_at'],
};

// In the form Postgres reports them, with the schema name removed.
const EXPECTED_INDEXES: Record<string, string> = {
  account_stores_one_active:
    "CREATE UNIQUE INDEX account_stores_one_active ON account_stores USING btree (account_id) WHERE (status = 'active'::text)",
  adapters_one_active:
    'CREATE UNIQUE INDEX adapters_one_active ON adapters USING btree (account_id, source, op, fingerprint) WHERE active',
  events_idempotency:
    'CREATE UNIQUE INDEX events_idempotency ON events USING btree (account_id, idempotency_key) WHERE (idempotency_key IS NOT NULL)',
  events_account_seq:
    'CREATE INDEX events_account_seq ON events USING btree (account_id, seq)',
  events_shape:
    'CREATE INDEX events_shape ON events USING btree (account_id, source, op, fingerprint)',
  queue_ready: 'CREATE INDEX queue_ready ON queue USING btree (run_at)',
  queue_one_replay:
    "CREATE UNIQUE INDEX queue_one_replay ON queue USING btree (adapter_id) WHERE (kind = 'replay'::text)",
  queue_one_rebuild:
    "CREATE UNIQUE INDEX queue_one_rebuild ON queue USING btree (store_id) WHERE (kind = 'rebuild'::text)",
  quarantine_unreleased:
    'CREATE INDEX quarantine_unreleased ON quarantine USING btree (account_id, event_id) WHERE (released_at IS NULL)',
  quarantine_one_open:
    'CREATE UNIQUE INDEX quarantine_one_open ON quarantine USING btree (event_id, store_id) NULLS NOT DISTINCT WHERE (released_at IS NULL)',
  adapter_attempts_one_running:
    "CREATE UNIQUE INDEX adapter_attempts_one_running ON adapter_attempts USING btree (account_id, source, op, fingerprint) WHERE (status = 'running'::text)",
};

beforeAll(async () => {
  await client.connect();
  await migrate('up', MIGRATIONS_THROUGH_APP_SCHEMA);
  await client.query(`SET search_path TO ${schema}`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

describe('application schema shape', () => {
  it('creates every table in §10 with the columns in §10', async () => {
    const result = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> 'schema_migrations'
       ORDER BY table_name, ordinal_position`,
      [schema],
    );
    const actual: Record<string, string[]> = {};
    for (const row of result.rows) (actual[row.table_name] ??= []).push(row.column_name);
    expect(actual).toEqual(EXPECTED_COLUMNS);
  });

  it('creates every named index in §10 with its uniqueness and predicate', async () => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND indexname NOT LIKE '%\\_pkey' AND indexname NOT LIKE '%\\_key'`,
      [schema],
    );
    const actual = Object.fromEntries(
      result.rows.map((row) => [row.indexname, row.indexdef.replaceAll(`${schema}.`, '')]),
    );
    expect(actual).toEqual(EXPECTED_INDEXES);
  });

  it('keeps defaults that contain characters a migration runner could mangle', async () => {
    const account = await createAccount();
    const row = await client
      .query(
        `INSERT INTO adapters (account_id, op, fingerprint, version, code)
         VALUES ($1, 'write', 'fp', 1, 'code') RETURNING source, opaque_paths, active`,
        [account],
      )
      .then((result) => result.rows[0]);
    expect(row).toEqual({ source: '', opaque_paths: [], active: false });
  });

  it('links accounts and account_stores in both directions', async () => {
    const account = await createAccount();
    await expect(
      client.query('UPDATE accounts SET active_store_id = $1 WHERE id = $2', [randomUUID(), account]),
    ).rejects.toMatchObject({ code: '23503' });

    const store = await createStore(account, 1);
    await client.query('UPDATE accounts SET active_store_id = $1 WHERE id = $2', [store, account]);
    await expect(
      client.query('DELETE FROM account_stores WHERE id = $1', [store]),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('partial unique indexes', () => {
  it('allows one active adapter per shape', async () => {
    const account = await createAccount();
    await createAdapter(account, { version: 1, active: true });

    await expect(createAdapter(account, { version: 2, active: true })).rejects.toMatchObject({
      code: '23505',
      constraint: 'adapters_one_active',
    });

    // Inactive versions of the same shape, and active adapters for other shapes, are fine.
    await createAdapter(account, { version: 2, active: false });
    await createAdapter(account, { version: 1, active: true, source: 'other' });
    await createAdapter(account, { version: 1, active: true, op: 'delete' });
    await createAdapter(account, { version: 1, active: true, fingerprint: 'other' });
    await createAdapter(await createAccount(), { version: 1, active: true });
  });

  it('allows one open quarantine entry per event and store', async () => {
    const account = await createAccount();
    const event = await createEvent(account);
    const store = await createStore(account, 1);
    const otherStore = await createStore(account, 2);

    const first = await quarantine(account, event, store);
    await expect(quarantine(account, event, store)).rejects.toMatchObject({
      code: '23505',
      constraint: 'quarantine_one_open',
    });

    // A different store is a separate failure, and a released entry no longer counts.
    await quarantine(account, event, otherStore);
    await client.query('UPDATE quarantine SET released_at = now() WHERE id = $1', [first]);
    await quarantine(account, event, store);
  });

  it('treats a NULL store as one value when checking open quarantine entries', async () => {
    const account = await createAccount();
    const event = await createEvent(account);

    const first = await quarantine(account, event, null);
    await expect(quarantine(account, event, null)).rejects.toMatchObject({
      code: '23505',
      constraint: 'quarantine_one_open',
    });

    await client.query('UPDATE quarantine SET released_at = now() WHERE id = $1', [first]);
    await quarantine(account, event, null);
  });

  it('allows one running attempt per shape', async () => {
    const account = await createAccount();
    const first = await createAttempt(account, 'running');

    await expect(createAttempt(account, 'running')).rejects.toMatchObject({
      code: '23505',
      constraint: 'adapter_attempts_one_running',
    });

    // A running attempt for another shape is fine, and a finished one no longer counts.
    await createAttempt(account, 'running', 'other');
    await createAttempt(account, 'failed');
    await client.query(`UPDATE adapter_attempts SET status = 'succeeded' WHERE id = $1`, [first]);
    await createAttempt(account, 'running');
  });

  it('enforces idempotency keys per account', async () => {
    const account = await createAccount();
    await createEvent(account, 'key-1');

    await expect(createEvent(account, 'key-1')).rejects.toMatchObject({
      code: '23505',
      constraint: 'events_idempotency',
    });

    // Another key, another account, and any number of events with no key are all fine.
    await createEvent(account, 'key-2');
    await createEvent(await createAccount(), 'key-1');
    await createEvent(account, null);
    await createEvent(account, null);
  });

  it('allows one active store per account', async () => {
    const account = await createAccount();
    await createStore(account, 1, 'active');

    await expect(createStore(account, 2, 'active')).rejects.toMatchObject({
      code: '23505',
      constraint: 'account_stores_one_active',
    });

    await createStore(account, 2, 'building');
    await createStore(await createAccount(), 1, 'active');
  });

  it('allows one queued replay per adapter and one queued rebuild per store', async () => {
    const account = await createAccount();
    const adapter = await createAdapter(account, { version: 1, active: false });
    const store = await createStore(account, 1);
    const insert = (kind: string, adapterId: string | null, storeId: string | null) =>
      client.query(
        'INSERT INTO queue (account_id, kind, adapter_id, store_id) VALUES ($1, $2, $3, $4)',
        [account, kind, adapterId, storeId],
      );

    await insert('replay', adapter, null);
    await expect(insert('replay', adapter, null)).rejects.toMatchObject({
      code: '23505',
      constraint: 'queue_one_replay',
    });

    await insert('rebuild', null, store);
    await expect(insert('rebuild', null, store)).rejects.toMatchObject({
      code: '23505',
      constraint: 'queue_one_rebuild',
    });
  });
});

// Runs last in this file because it removes the schema the tests above use.
describe('migration reversibility', () => {
  it('leaves nothing behind going down, and applies again going up', async () => {
    const before = await listTables();
    expect(before).toEqual(Object.keys(EXPECTED_COLUMNS).sort());

    await migrate('down', 1);
    expect(await listTables()).toEqual([]);

    await migrate('up', 1);
    expect(await listTables()).toEqual(before);
  });
});

async function insertReturningId(sql: string, values: unknown[]): Promise<string> {
  const result = await client.query<{ id: string }>(`${sql} RETURNING id`, values);
  return result.rows[0]!.id;
}

function createAccount(): Promise<string> {
  return insertReturningId('INSERT INTO accounts (slug) VALUES ($1)', [randomUUID()]);
}

function createStore(account: string, generation: number, status = 'building'): Promise<string> {
  return insertReturningId(
    `INSERT INTO account_stores (account_id, generation, backend, connection, namespace, status)
     VALUES ($1, $2, 'postgres', '{}', 'ns', $3)`,
    [account, generation, status],
  );
}

function createAdapter(
  account: string,
  shape: { version: number; active: boolean; source?: string; op?: string; fingerprint?: string },
): Promise<string> {
  return insertReturningId(
    `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, active)
     VALUES ($1, $2, $3, $4, $5, 'code', $6)`,
    [
      account,
      shape.source ?? '',
      shape.op ?? 'write',
      shape.fingerprint ?? 'fp',
      shape.version,
      shape.active,
    ],
  );
}

function createEvent(account: string, idempotencyKey: string | null = null): Promise<string> {
  return insertReturningId(
    `INSERT INTO events (account_id, body, op, fingerprint, idempotency_key, request)
     VALUES ($1, '\\x7b7d', 'write', 'fp', $2, '{}')`,
    [account, idempotencyKey],
  );
}

function quarantine(account: string, event: string, store: string | null): Promise<string> {
  return insertReturningId(
    `INSERT INTO quarantine (event_id, account_id, store_id, reason)
     VALUES ($1, $2, $3, 'write_error')`,
    [event, account, store],
  );
}

function createAttempt(account: string, status: string, fingerprint = 'fp'): Promise<string> {
  return insertReturningId(
    `INSERT INTO adapter_attempts (account_id, op, fingerprint, status)
     VALUES ($1, 'write', $2, $3)`,
    [account, fingerprint, status],
  );
}

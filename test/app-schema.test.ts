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

// Each column as: name, type, then nullability, default, and identity where they apply.
const EXPECTED_COLUMNS: Record<string, string[]> = {
  accounts: [
    'id uuid not null default gen_random_uuid()',
    'slug text not null',
    'auto_activate bool not null default true',
    "status text not null default 'provisioning'::text",
    'created_at timestamptz not null default now()',
  ],
  account_stores: [
    'id uuid not null default gen_random_uuid()',
    'account_id uuid not null',
    'generation int4 not null',
    'backend text not null',
    'connection jsonb not null',
    'credentials bytea',
    'read_credentials bytea',
    'namespace text not null',
    'status text not null',
    'rebuild_through_seq int8',
    'rebuild_cursor int8',
    'created_at timestamptz not null default now()',
  ],
  api_keys: [
    'id uuid not null default gen_random_uuid()',
    'account_id uuid not null',
    'key_hash text not null',
    'created_at timestamptz not null default now()',
    'revoked_at timestamptz',
  ],
  adapters: [
    'id uuid not null default gen_random_uuid()',
    'account_id uuid not null',
    "source text not null default ''::text",
    'op text not null',
    'fingerprint text not null',
    "opaque_paths _text not null default '{}'::text[]",
    'version int4 not null',
    'code text not null',
    'active bool not null default false',
    'validated_at timestamptz',
    'superseded_at timestamptz',
    'created_at timestamptz not null default now()',
  ],
  adapter_fingerprints: [
    'adapter_id uuid not null',
    'fingerprint text not null',
    'created_at timestamptz not null default now()',
  ],
  events: [
    'id uuid not null default gen_random_uuid()',
    'seq int8 not null identity',
    'account_id uuid not null',
    'body bytea not null',
    "source text not null default ''::text",
    'op text not null',
    'fingerprint text',
    'idempotency_key text',
    'request jsonb not null',
    'received_at timestamptz not null default now()',
  ],
  queue: [
    'id uuid not null default gen_random_uuid()',
    'account_id uuid not null',
    'kind text not null',
    'event_id uuid',
    'adapter_id uuid',
    'store_id uuid',
    'run_at timestamptz not null default now()',
    'attempts int4 not null default 0',
    'rerun_requested bool not null default false',
    'created_at timestamptz not null default now()',
  ],
  quarantine: [
    'id uuid not null default gen_random_uuid()',
    'event_id uuid not null',
    'account_id uuid not null',
    'store_id uuid',
    'reason text not null',
    'detail text',
    'quarantined_at timestamptz not null default now()',
    'released_at timestamptz',
    'released_by_adapter_id uuid',
  ],
  replay_log: [
    'id int8 not null identity',
    'quarantine_id uuid not null',
    'adapter_id uuid not null',
    'status text not null',
    'detail text',
    'attempted_at timestamptz not null default now()',
  ],
  adapter_attempts: [
    'id uuid not null default gen_random_uuid()',
    'account_id uuid not null',
    "source text not null default ''::text",
    'op text not null',
    'fingerprint text not null',
    'status text not null',
    'adapter_id uuid',
    'detail text',
    'started_at timestamptz not null default now()',
    'finished_at timestamptz',
  ],
  data_columns: [
    'store_id uuid not null',
    'table_name text not null',
    'column_name text not null',
    'logical_type text not null',
    'created_at timestamptz not null default now()',
  ],
};

// In the form Postgres reports them. Compared by definition, because the names of unnamed
// constraints are generated.
const EXPECTED_CONSTRAINTS: Record<string, string[]> = {
  accounts: [
    'PRIMARY KEY (id)',
    'UNIQUE (slug)',
    "CHECK ((slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text))",
    "CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'disabled'::text])))",
  ],
  account_stores: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'UNIQUE (account_id, generation)',
    'UNIQUE (account_id, id)',
    "CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'active'::text, 'retired'::text])))",
  ],
  api_keys: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'UNIQUE (key_hash)',
  ],
  adapters: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'UNIQUE (account_id, id)',
    'UNIQUE (account_id, source, op, fingerprint, version)',
    "CHECK ((op = ANY (ARRAY['write'::text, 'delete'::text])))",
    'CHECK ((octet_length(source) <= 255))',
  ],
  adapter_fingerprints: [
    'PRIMARY KEY (adapter_id, fingerprint)',
    'FOREIGN KEY (adapter_id) REFERENCES adapters(id)',
  ],
  events: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'UNIQUE (account_id, id)',
    'UNIQUE (seq)',
    "CHECK ((op = ANY (ARRAY['write'::text, 'delete'::text])))",
    'CHECK ((octet_length(source) <= 255))',
    'CHECK ((octet_length(idempotency_key) <= 255))',
  ],
  queue: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, id)',
    'FOREIGN KEY (account_id, adapter_id) REFERENCES adapters(account_id, id)',
    'FOREIGN KEY (account_id, store_id) REFERENCES account_stores(account_id, id)',
    "CHECK ((kind = ANY (ARRAY['ingest'::text, 'replay'::text, 'rebuild'::text])))",
    "CHECK ((((kind = 'ingest'::text) AND (event_id IS NOT NULL) AND (adapter_id IS NULL) AND (store_id IS NULL)) OR ((kind = 'replay'::text) AND (adapter_id IS NOT NULL) AND (event_id IS NULL) AND (store_id IS NULL)) OR ((kind = 'rebuild'::text) AND (store_id IS NOT NULL) AND (event_id IS NULL) AND (adapter_id IS NULL))))",
    "CHECK (((kind = 'replay'::text) OR (NOT rerun_requested)))",
  ],
  quarantine: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'FOREIGN KEY (account_id, event_id) REFERENCES events(account_id, id)',
    'FOREIGN KEY (account_id, store_id) REFERENCES account_stores(account_id, id)',
    'FOREIGN KEY (account_id, released_by_adapter_id) REFERENCES adapters(account_id, id)',
    "CHECK ((reason = ANY (ARRAY['unknown_fingerprint'::text, 'malformed'::text, 'adapter_error'::text, 'schema_conflict'::text, 'write_error'::text])))",
  ],
  replay_log: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (quarantine_id) REFERENCES quarantine(id)',
    'FOREIGN KEY (adapter_id) REFERENCES adapters(id)',
  ],
  adapter_attempts: [
    'PRIMARY KEY (id)',
    'FOREIGN KEY (account_id) REFERENCES accounts(id)',
    'FOREIGN KEY (account_id, adapter_id) REFERENCES adapters(account_id, id)',
    "CHECK ((op = ANY (ARRAY['write'::text, 'delete'::text])))",
    'CHECK ((octet_length(source) <= 255))',
    "CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])))",
  ],
  data_columns: [
    'PRIMARY KEY (store_id, table_name, column_name)',
    'FOREIGN KEY (store_id) REFERENCES account_stores(id)',
    "CHECK ((logical_type = ANY (ARRAY['string'::text, 'number'::text, 'boolean'::text, 'timestamp'::text, 'json'::text])))",
  ],
};

// In the form Postgres reports them, with the schema name removed. Indexes that back a
// constraint are covered by EXPECTED_CONSTRAINTS.
const EXPECTED_INDEXES: Record<string, string> = {
  account_stores_one_active:
    "CREATE UNIQUE INDEX account_stores_one_active ON account_stores USING btree (account_id) WHERE (status = 'active'::text)",
  adapters_one_active:
    'CREATE UNIQUE INDEX adapters_one_active ON adapters USING btree (account_id, source, op, fingerprint) WHERE active',
  events_idempotency:
    'CREATE UNIQUE INDEX events_idempotency ON events USING btree (account_id, source, op, idempotency_key) WHERE (idempotency_key IS NOT NULL)',
  events_account_seq: 'CREATE INDEX events_account_seq ON events USING btree (account_id, seq)',
  events_shape:
    'CREATE INDEX events_shape ON events USING btree (account_id, source, op, fingerprint)',
  queue_ready: 'CREATE INDEX queue_ready ON queue USING btree (run_at)',
  queue_one_ingest:
    "CREATE UNIQUE INDEX queue_one_ingest ON queue USING btree (event_id) WHERE (kind = 'ingest'::text)",
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

const sortedValues = (record: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, [...value].sort()]));

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
  it('creates every table in §10 with the column definitions in §10', async () => {
    const result = await client.query<{ table_name: string; definition: string }>(
      `SELECT table_name,
              column_name || ' ' || udt_name
                || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE '' END
                || COALESCE(' default ' || column_default, '')
                || CASE WHEN is_identity = 'YES' THEN ' identity' ELSE '' END AS definition
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name <> 'schema_migrations'
       ORDER BY table_name, ordinal_position`,
      [schema],
    );
    const actual: Record<string, string[]> = {};
    for (const row of result.rows) (actual[row.table_name] ??= []).push(row.definition);
    expect(actual).toEqual(EXPECTED_COLUMNS);
  });

  it('creates every constraint in §10', async () => {
    const result = await client.query<{ table_name: string; definition: string }>(
      `SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = $1 AND rel.relname <> 'schema_migrations'
         AND con.contype IN ('c', 'f', 'p', 'u')`,
      [schema],
    );
    const actual: Record<string, string[]> = {};
    for (const row of result.rows) {
      (actual[row.table_name] ??= []).push(row.definition.replaceAll(`${schema}.`, ''));
    }
    expect(sortedValues(actual)).toEqual(sortedValues(EXPECTED_CONSTRAINTS));
  });

  it('creates every named index in §10 with its uniqueness and predicate', async () => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename <> 'schema_migrations'
         AND indexname NOT IN (
           SELECT conname FROM pg_constraint WHERE connamespace = $1::regnamespace
         )`,
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

  it('lets the generator replace a stale running attempt in one transaction (§12.1)', async () => {
    const account = await createAccount();
    const stale = await createAttempt(account, 'running');

    await client.query('BEGIN');
    try {
      await client.query(`UPDATE adapter_attempts SET status = 'failed' WHERE id = $1`, [stale]);
      await createAttempt(account, 'running');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  it('enforces idempotency keys per account, source, and op', async () => {
    const account = await createAccount();
    await createEvent(account, { key: 'key-1' });

    await expect(createEvent(account, { key: 'key-1' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'events_idempotency',
    });

    // Any other part of the key differing, and any number of events with no key, are all fine.
    await createEvent(account, { key: 'key-2' });
    await createEvent(account, { key: 'key-1', source: 'other' });
    await createEvent(account, { key: 'key-1', op: 'delete' });
    await createEvent(await createAccount(), { key: 'key-1' });
    await createEvent(account);
    await createEvent(account);
  });

  it('allows one active store per account', async () => {
    const account = await createAccount();
    const first = await createStore(account, 1, 'active');

    await expect(createStore(account, 2, 'active')).rejects.toMatchObject({
      code: '23505',
      constraint: 'account_stores_one_active',
    });

    await createStore(await createAccount(), 1, 'active');

    // Activation retires the old store first (§5.4).
    const second = await createStore(account, 2, 'ready');
    await client.query('BEGIN');
    try {
      await client.query(`UPDATE account_stores SET status = 'retired' WHERE id = $1`, [first]);
      await client.query(`UPDATE account_stores SET status = 'active' WHERE id = $1`, [second]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  it('allows one queued job per event, adapter replay, and store rebuild', async () => {
    const account = await createAccount();
    const event = await createEvent(account);
    const adapter = await createAdapter(account, { version: 1, active: false });
    const store = await createStore(account, 1);

    await enqueue(account, 'ingest', { event });
    await expect(enqueue(account, 'ingest', { event })).rejects.toMatchObject({
      code: '23505',
      constraint: 'queue_one_ingest',
    });

    await enqueue(account, 'replay', { adapter });
    await expect(enqueue(account, 'replay', { adapter })).rejects.toMatchObject({
      code: '23505',
      constraint: 'queue_one_replay',
    });

    await enqueue(account, 'rebuild', { store });
    await expect(enqueue(account, 'rebuild', { store })).rejects.toMatchObject({
      code: '23505',
      constraint: 'queue_one_rebuild',
    });
  });
});

describe('queue rules', () => {
  it('records a replay requested during a replay, and runs it again (§10.1)', async () => {
    const account = await createAccount();
    const adapter = await createAdapter(account, { version: 1, active: true });
    const requestReplay = () =>
      client.query(
        `INSERT INTO queue (account_id, kind, adapter_id) VALUES ($1, 'replay', $2)
         ON CONFLICT (adapter_id) WHERE kind = 'replay' DO UPDATE SET rerun_requested = true`,
        [account, adapter],
      );
    const finishReplay = async () => {
      await client.query(
        `DELETE FROM queue WHERE adapter_id = $1 AND kind = 'replay' AND NOT rerun_requested`,
        [adapter],
      );
      await client.query(
        `UPDATE queue SET rerun_requested = false, run_at = now()
         WHERE adapter_id = $1 AND kind = 'replay'`,
        [adapter],
      );
    };
    const jobs = async () =>
      (
        await client.query('SELECT rerun_requested FROM queue WHERE adapter_id = $1', [adapter])
      ).rows.map((row) => row.rerun_requested);

    await requestReplay();
    expect(await jobs()).toEqual([false]);

    await requestReplay();
    expect(await jobs()).toEqual([true]);

    await finishReplay();
    expect(await jobs()).toEqual([false]);

    await finishReplay();
    expect(await jobs()).toEqual([]);
  });

  it('rejects a re-run flag on a job that is not a replay', async () => {
    const account = await createAccount();
    const event = await createEvent(account);
    await expect(
      client.query(
        `INSERT INTO queue (account_id, kind, event_id, rerun_requested)
         VALUES ($1, 'ingest', $2, true)`,
        [account, event],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires a job to reference only the target for its kind', async () => {
    const account = await createAccount();
    const event = await createEvent(account);
    const adapter = await createAdapter(account, { version: 1, active: false });
    const store = await createStore(account, 1);

    for (const [kind, refs] of [
      ['ingest', {}],
      ['ingest', { adapter }],
      ['ingest', { event, adapter }],
      ['ingest', { event, store }],
      ['replay', { store }],
      ['replay', { adapter, event }],
      ['replay', { adapter, store }],
      ['rebuild', { event }],
      ['rebuild', { store, event }],
      ['rebuild', { store, adapter }],
    ] as const) {
      await expect(enqueue(account, kind, refs)).rejects.toMatchObject({
        code: '23514',
        constraint: 'queue_check',
      });
    }
  });
});

describe('same-account references', () => {
  async function twoAccounts() {
    const account = await createAccount();
    const other = await createAccount();
    return {
      account,
      event: await createEvent(account),
      adapter: await createAdapter(account, { version: 1, active: true }),
      store: await createStore(account, 1),
      otherEvent: await createEvent(other),
      otherAdapter: await createAdapter(other, { version: 1, active: true }),
      otherStore: await createStore(other, 1),
    };
  }
  const foreignKeyViolation = { code: '23503' };

  it('rejects queue jobs that target another account', async () => {
    const t = await twoAccounts();
    await expect(enqueue(t.account, 'ingest', { event: t.otherEvent })).rejects.toMatchObject(
      foreignKeyViolation,
    );
    await expect(enqueue(t.account, 'replay', { adapter: t.otherAdapter })).rejects.toMatchObject(
      foreignKeyViolation,
    );
    await expect(enqueue(t.account, 'rebuild', { store: t.otherStore })).rejects.toMatchObject(
      foreignKeyViolation,
    );

    await enqueue(t.account, 'ingest', { event: t.event });
    await enqueue(t.account, 'replay', { adapter: t.adapter });
    await enqueue(t.account, 'rebuild', { store: t.store });
  });

  it('rejects quarantine entries that reference another account', async () => {
    const t = await twoAccounts();
    await expect(quarantine(t.account, t.otherEvent, null)).rejects.toMatchObject(
      foreignKeyViolation,
    );
    await expect(quarantine(t.account, t.event, t.otherStore)).rejects.toMatchObject(
      foreignKeyViolation,
    );

    const entry = await quarantine(t.account, t.event, t.store);
    await expect(
      client.query('UPDATE quarantine SET released_by_adapter_id = $1 WHERE id = $2', [
        t.otherAdapter,
        entry,
      ]),
    ).rejects.toMatchObject(foreignKeyViolation);
    await client.query('UPDATE quarantine SET released_by_adapter_id = $1 WHERE id = $2', [
      t.adapter,
      entry,
    ]);
  });

  it('rejects adapter attempts that reference another account', async () => {
    const t = await twoAccounts();
    const attempt = await createAttempt(t.account, 'succeeded');
    await expect(
      client.query('UPDATE adapter_attempts SET adapter_id = $1 WHERE id = $2', [
        t.otherAdapter,
        attempt,
      ]),
    ).rejects.toMatchObject(foreignKeyViolation);
    await client.query('UPDATE adapter_attempts SET adapter_id = $1 WHERE id = $2', [
      t.adapter,
      attempt,
    ]);
  });
});

describe('value limits', () => {
  const atLimit = 'a'.repeat(255);
  const overLimit = 'a'.repeat(256);
  // 258 bytes in 86 characters, so a limit that counted characters would let this through.
  const overLimitMultibyte = '€'.repeat(86);
  const tooLong = { code: '23514' };

  it('limits event sources and idempotency keys to 255 bytes', async () => {
    const account = await createAccount();

    await createEvent(account, { source: atLimit });
    await expect(createEvent(account, { source: overLimit })).rejects.toMatchObject(tooLong);
    await expect(createEvent(account, { source: overLimitMultibyte })).rejects.toMatchObject(
      tooLong,
    );

    await createEvent(account, { key: atLimit });
    await expect(createEvent(account, { key: overLimit })).rejects.toMatchObject(tooLong);
    await expect(createEvent(account, { key: overLimitMultibyte })).rejects.toMatchObject(tooLong);
  });

  it('accepts a source and key both at the limit without hitting the index size limit', async () => {
    const account = await createAccount();
    const incompressible = Array.from({ length: 16 }, () => randomUUID().replaceAll('-', ''))
      .join('')
      .slice(0, 255);
    await createEvent(account, { source: incompressible, key: incompressible });
  });

  it('limits sources on adapters and adapter attempts to 255 bytes', async () => {
    const account = await createAccount();
    await createAdapter(account, { version: 1, active: false, source: atLimit });
    await expect(
      createAdapter(account, { version: 1, active: false, source: overLimit }),
    ).rejects.toMatchObject(tooLong);

    await createAttempt(account, 'failed', 'fp', atLimit);
    await expect(createAttempt(account, 'failed', 'fp', overLimit)).rejects.toMatchObject(tooLong);
  });

  it('allows only one lowercase DNS label as an account slug', async () => {
    const insert = (slug: string) => client.query('INSERT INTO accounts (slug) VALUES ($1)', [slug]);
    const unique = randomUUID().replaceAll('-', '').slice(0, 20);

    await insert(`${unique}a`);
    await insert(`${unique}-b-1`);
    await insert(unique.padEnd(63, 'c'));

    for (const slug of [
      '',
      'Acme',
      'a.b',
      'foo bar',
      `-${unique}`,
      `${unique}-`,
      `${unique}_x`,
      unique.padEnd(64, 'd'),
    ]) {
      await expect(insert(slug), slug).rejects.toMatchObject({
        code: '23514',
        constraint: 'accounts_slug_check',
      });
    }
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

function createEvent(
  account: string,
  options: { key?: string; source?: string; op?: string } = {},
): Promise<string> {
  return insertReturningId(
    `INSERT INTO events (account_id, body, source, op, fingerprint, idempotency_key, request)
     VALUES ($1, '\\x7b7d', $2, $3, 'fp', $4, '{}')`,
    [account, options.source ?? '', options.op ?? 'write', options.key ?? null],
  );
}

function enqueue(
  account: string,
  kind: 'ingest' | 'replay' | 'rebuild',
  refs: { event?: string; adapter?: string; store?: string },
): Promise<string> {
  return insertReturningId(
    `INSERT INTO queue (account_id, kind, event_id, adapter_id, store_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [account, kind, refs.event ?? null, refs.adapter ?? null, refs.store ?? null],
  );
}

function quarantine(account: string, event: string, store: string | null): Promise<string> {
  return insertReturningId(
    `INSERT INTO quarantine (event_id, account_id, store_id, reason)
     VALUES ($1, $2, $3, 'write_error')`,
    [event, account, store],
  );
}

function createAttempt(
  account: string,
  status: string,
  fingerprint = 'fp',
  source = '',
): Promise<string> {
  return insertReturningId(
    `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status)
     VALUES ($1, $2, 'write', $3, $4)`,
    [account, source, fingerprint, status],
  );
}

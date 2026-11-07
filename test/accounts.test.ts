import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { StorageError } from '../src/contracts/index.js';
import type { StorageBackend, StoreConfig } from '../src/contracts/index.js';
import { authenticate } from '../src/http/auth.js';
import { createApp, MAX_BODY_BYTES } from '../src/http/app.js';
import { decryptJson } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const TOKEN = 'accounts-test-token';
const config = { ...loadConfig(), internalApiToken: TOKEN };
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

// Routes that use the auth helper, as /ingest will.
app.get('/probe', async (c) => c.json(await authenticate(c, { allowQueryKey: false })));
app.get('/probe-query', async (c) => c.json(await authenticate(c, { allowQueryKey: true })));

const slugs: string[] = [];
function newSlug(label = 't'): string {
  const slug = `${label}-${randomBytes(5).toString('hex')}`;
  slugs.push(slug);
  return slug;
}

function post(appUnderTest: { request: typeof app.request }, body: unknown) {
  return appUnderTest.request('/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Created {
  account_id: string;
  slug: string;
  api_key: string;
  database: { host: string; port: number; database: string; user: string; password: string };
}

async function createAccount(label?: string): Promise<Created> {
  const res = await post(app, { slug: newSlug(label) });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

function probe(path: string, slug: string | undefined, headers: Record<string, string> = {}) {
  return app.request(path, {
    headers: { ...(slug ? { 'x-account-slug': slug } : {}), ...headers },
  });
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'postgres',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  const { rows } = await appDb.query<{ id: string }>(
    'SELECT id FROM accounts WHERE slug = ANY($1)',
    [slugs],
  );
  for (const { id } of rows) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
    await appDb.query('DELETE FROM api_keys WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM account_stores WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.end();
});

describe('POST /accounts', () => {
  describe('the internal guard', () => {
    const attempt = (headers: Record<string, string>, target = app) =>
      target.request('/accounts', { method: 'POST', headers, body: JSON.stringify({ slug: 'guard-never-created' }) });
    const operator = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

    afterAll(async () => {
      const { rowCount } = await appDb.query(`SELECT 1 FROM accounts WHERE slug = 'guard-never-created'`);
      expect(rowCount).toBe(0);
    });

    it.each([
      ['no token', { 'content-type': 'application/json' }],
      ['a wrong token', { ...operator, authorization: 'Bearer nope' }],
    ])('refuses %s', async (_name, headers: Record<string, string>) => {
      const response = await attempt(headers);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    });

    it('refuses everything when no token is configured', async () => {
      const closed = createApp({ appDb, backend, config: { ...config, internalApiToken: undefined } });
      expect((await attempt(operator, closed)).status).toBe(401);
    });

    it.each(['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'via', 'x-account-slug'])(
      'hides the route from a request with %s, even with the token',
      async (header) => {
        expect((await attempt({ ...operator, [header]: 'x' })).status).toBe(404);
      },
    );

    it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
      'refuses a body sent as %s, as a browser could from any page',
      async (type) => {
        expect((await attempt({ ...operator, 'content-type': type })).status).toBe(415);
      },
    );
  });

  it('rejects a bad slug', async () => {
    for (const slug of ['', 'Upper', 'a.b', '-a', 'a-', 'a'.repeat(64), 'a b', 5, undefined]) {
      const res = await post(app, { slug });
      expect(res.status, JSON.stringify(slug)).toBe(400);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    }
    expect((await post(app, [])).status).toBe(400);
    const notJson = await app.request('/accounts', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'nope',
    });
    expect(notJson.status).toBe(400);
  });

  it('rejects an unsupported backend', async () => {
    const res = await post(app, { slug: newSlug(), storage: { backend: 'clickhouse' } });
    expect(res.status).toBe(400);
  });

  it('rejects malformed postgres storage', async () => {
    const connection = { host: 'localhost', port: 5432, database: 'postgres' };
    const credentials = { user: 'u', password: 'p' };
    const cases: Record<string, unknown> = {
      'only a backend': { backend: 'postgres' },
      null: null,
      'a string': 'postgres',
      'an array': [],
      'no backend': { connection, credentials },
      'string port': { backend: 'postgres', connection: { ...connection, port: '5432' }, credentials },
      'no host': { backend: 'postgres', connection: { port: 5432, database: 'd' }, credentials },
      'no database': { backend: 'postgres', connection: { host: 'h', port: 5432 }, credentials },
      'numeric password': { backend: 'postgres', connection, credentials: { user: 'u', password: 1 } },
      'no user': { backend: 'postgres', connection, credentials: { password: 'p' } },
      'no credentials': { backend: 'postgres', connection },
    };
    for (const [name, storage] of Object.entries(cases)) {
      const res = await post(app, { slug: newSlug(), storage });
      expect(res.status, name).toBe(400);
      expect(await res.json(), name).toEqual({ error: expect.any(String) });
    }
  });

  it('creates an account with a key and working read-only credentials', async () => {
    const created = await createAccount();
    expect(created.api_key).toMatch(/^sw_[A-Za-z0-9_-]{43}$/);
    const { database } = created;
    expect(database.host).toBe('localhost');
    expect(database.port).toBe(config.postgresPort);
    expect(database.database).toBe(`acct_${created.account_id.replaceAll('-', '')}_1`);
    expect(database.database).not.toBe('postgres');

    const connect = (name: string) =>
      new pg.Client({
        host: database.host,
        port: database.port,
        user: database.user,
        password: database.password,
        database: name,
      });

    const customer = connect(database.database);
    await customer.connect();
    try {
      expect((await customer.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
      await expect(customer.query('CREATE TABLE nope (id int)')).rejects.toMatchObject({
        code: expect.stringMatching(/^(42501|25006)$/),
      });

      // A table created after provisioning must be readable (default privileges) but not writable.
      const owner = new pg.Client({
        host: database.host,
        port: database.port,
        user: 'sw_data',
        password: config.dataDbPassword,
        database: database.database,
      });
      await owner.connect();
      try {
        await owner.query('CREATE TABLE readable (id int, note text)');
        await owner.query(`INSERT INTO readable VALUES (1, 'hello')`);
      } finally {
        await owner.end();
      }
      expect((await customer.query('SELECT id, note FROM readable')).rows).toEqual([
        { id: 1, note: 'hello' },
      ]);
      for (const statement of [
        `INSERT INTO readable VALUES (2, 'x')`,
        `UPDATE readable SET note = 'x'`,
        'DELETE FROM readable',
        'DROP TABLE readable',
      ]) {
        await expect(customer.query(statement), statement).rejects.toMatchObject({
          code: expect.stringMatching(/^(42501|25006)$/),
        });
      }
    } finally {
      await customer.end();
    }
    const app_ = connect('sw_app');
    await expect(app_.connect()).rejects.toThrow();
    await app_.end().catch(() => undefined);

    const { rows } = await appDb.query(
      `SELECT a.status AS account, s.status AS store, s.generation, s.namespace, s.connection
       FROM accounts a JOIN account_stores s ON s.account_id = a.id WHERE a.id = $1`,
      [created.account_id],
    );
    expect(rows).toEqual([
      {
        account: 'active',
        store: 'active',
        generation: 1,
        namespace: database.database,
        connection: { host: 'localhost', port: config.postgresPort, database: 'postgres' },
      },
    ]);
  });

  it('encrypts both credential columns', async () => {
    const created = await createAccount();
    const { rows } = await appDb.query<{ credentials: Buffer; read_credentials: Buffer }>(
      'SELECT credentials, read_credentials FROM account_stores WHERE account_id = $1',
      [created.account_id],
    );
    const [row] = rows;
    expect(decryptJson(config.encryptionKey, row!.credentials)).toEqual({
      user: 'sw_data',
      password: config.dataDbPassword,
    });
    expect(decryptJson(config.encryptionKey, row!.read_credentials)).toEqual({
      user: created.database.user,
      password: created.database.password,
      database: created.database.database,
    });
    expect(row!.read_credentials.includes(Buffer.from(created.database.password))).toBe(false);
  });

  it('stores only the key hash, and the raw key appears nowhere', async () => {
    const created = await createAccount();
    const { rows } = await appDb.query<{ key_hash: string }>(
      'SELECT key_hash FROM api_keys WHERE account_id = $1',
      [created.account_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.key_hash).not.toBe(created.api_key);

    for (const table of ['accounts', 'account_stores', 'api_keys']) {
      const dump = await appDb.query<{ row: string }>(
        `SELECT t::text AS row FROM ${table} t WHERE account_id = $1`.replace(
          'account_id',
          table === 'accounts' ? 'id' : 'account_id',
        ),
        [created.account_id],
      );
      for (const { row } of dump.rows) expect(row).not.toContain(created.api_key);
    }
  });

  it('answers 409 for an account that is already active', async () => {
    const created = await createAccount();
    const res = await post(app, { slug: created.slug });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain('sw_');
  });

  it('creates one account from concurrent requests for one slug', async () => {
    const slug = newSlug('race');
    const results = await Promise.all(
      [1, 2, 3, 4].map(async () => (await post(app, { slug })).status),
    );
    expect(results.sort()).toEqual([201, 409, 409, 409]);
    const { rows } = await appDb.query('SELECT count(*)::int AS n FROM accounts WHERE slug = $1', [
      slug,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('leaves the account provisioning after a failed provision, and a retry completes it', async () => {
    let calls = 0;
    const flaky: StorageBackend = {
      capabilities: backend.capabilities,
      provision: async (store: StoreConfig) => {
        if (++calls === 1) throw new StorageError('connection lost', { retryable: true });
        return backend.provision(store);
      },
      applySchema: (store, changes) => backend.applySchema(store, changes),
      write: (store, tables) => backend.write(store, tables),
      health: (store) => backend.health(store),
    };
    const flakyApp = createApp({ appDb, backend: flaky, config });
    const slug = newSlug('retry');

    const failed = await post(flakyApp, { slug });
    expect(failed.status).toBe(503);
    const state = await appDb.query(
      `SELECT a.status AS account, s.status AS store,
              (SELECT count(*)::int FROM api_keys k WHERE k.account_id = a.id) AS keys
       FROM accounts a JOIN account_stores s ON s.account_id = a.id WHERE a.slug = $1`,
      [slug],
    );
    expect(state.rows).toEqual([{ account: 'provisioning', store: 'building', keys: 0 }]);

    const retried = await post(flakyApp, { slug });
    expect(retried.status).toBe(201);
    const created = (await retried.json()) as Created;
    const after = await appDb.query(
      `SELECT a.status AS account, s.status AS store, count(*) OVER () AS stores
       FROM accounts a JOIN account_stores s ON s.account_id = a.id WHERE a.slug = $1`,
      [slug],
    );
    expect(after.rows).toEqual([{ account: 'active', store: 'active', stores: '1' }]);
    expect((await probe('/probe', slug, bearer(created.api_key))).status).toBe(200);
  });

  it('answers 500 for a permanent provision failure and stays provisioning', async () => {
    const broken: StorageBackend = {
      capabilities: backend.capabilities,
      provision: async () => {
        throw new StorageError('nope', { retryable: false });
      },
      applySchema: (store, changes) => backend.applySchema(store, changes),
      write: (store, tables) => backend.write(store, tables),
      health: (store) => backend.health(store),
    };
    const slug = newSlug('perm');
    const res = await post(createApp({ appDb, backend: broken, config }), { slug });
    expect(res.status).toBe(500);
    const { rows } = await appDb.query('SELECT status FROM accounts WHERE slug = $1', [slug]);
    expect(rows).toEqual([{ status: 'provisioning' }]);
  });
});

describe('authenticate', () => {
  let a: Created;
  let b: Created;
  let disabled: Created;
  let revoked: Created;

  beforeAll(async () => {
    [a, b, disabled, revoked] = await Promise.all([
      createAccount('auth'),
      createAccount('auth'),
      createAccount('auth'),
      createAccount('auth'),
    ]);
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [
      disabled.account_id,
    ]);
    await appDb.query('UPDATE api_keys SET revoked_at = now() WHERE account_id = $1', [
      revoked.account_id,
    ]);
  });

  it('returns the account for a valid key', async () => {
    const res = await probe('/probe', a.slug, bearer(a.api_key));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accountId: a.account_id, slug: a.slug });
  });

  it('answers 404 for an unknown or missing slug, before checking the key', async () => {
    expect((await probe('/probe', 'no-such-account', bearer(a.api_key))).status).toBe(404);
    expect((await probe('/probe', undefined, bearer(a.api_key))).status).toBe(404);
    expect((await probe('/probe', 'no-such-account')).status).toBe(404);
  });

  it('answers 401 for a missing, bad, revoked or other account key', async () => {
    expect((await probe('/probe', a.slug)).status).toBe(401);
    expect((await probe('/probe', a.slug, bearer('sw_wrong'))).status).toBe(401);
    expect((await probe('/probe', a.slug, { authorization: a.api_key })).status).toBe(401);
    expect((await probe('/probe', a.slug, bearer(b.api_key))).status).toBe(401);
    expect((await probe('/probe', revoked.slug, bearer(revoked.api_key))).status).toBe(401);
  });

  it('answers 403 for a disabled account, but only after the key checks out', async () => {
    expect((await probe('/probe', disabled.slug, bearer(disabled.api_key))).status).toBe(403);
    expect((await probe('/probe', disabled.slug, bearer('sw_wrong'))).status).toBe(401);
  });

  it('answers 403 for an account still provisioning', async () => {
    await appDb.query(`UPDATE accounts SET status = 'provisioning' WHERE id = $1`, [
      b.account_id,
    ]);
    try {
      expect((await probe('/probe', b.slug, bearer(b.api_key))).status).toBe(403);
    } finally {
      await appDb.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [b.account_id]);
    }
  });

  it('accepts ?key= only when allowQueryKey is set', async () => {
    const q = `?key=${encodeURIComponent(a.api_key)}`;
    expect((await probe(`/probe${q}`, a.slug)).status).toBe(401);
    expect((await probe(`/probe-query${q}`, a.slug)).status).toBe(200);
    expect((await probe('/probe-query?key=sw_wrong', a.slug)).status).toBe(401);
    expect((await probe('/probe-query', a.slug, bearer(a.api_key))).status).toBe(200);
  });
});

describe('app-wide behavior', () => {
  it('answers /healthz while the app database is up', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('answers 503 when the app database is unreachable', async () => {
    const dead = new pg.Pool({
      host: '127.0.0.1',
      port: 1,
      user: 'x',
      password: 'x',
      database: 'x',
      connectionTimeoutMillis: 2000,
    });
    dead.on('error', () => undefined);
    const deadApp = createApp({ appDb: dead, backend, config });
    try {
      expect((await deadApp.request('/healthz')).status).toBe(503);
      expect((await post(deadApp, { slug: 'dead-db' })).status).toBe(503);
      const res = await deadApp.request('/healthz');
      expect(await res.json()).toEqual({ error: 'database unavailable' });
    } finally {
      await dead.end();
    }
  });

  it('answers 413 over the body limit', async () => {
    const res = await app.request('/accounts', {
      method: 'POST',
      body: 'x'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'body too large' });
  });

  it('answers 503 when the database accepts a connection but never responds', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const hung = new pg.Pool({
      host: '127.0.0.1',
      port,
      user: 'nobody',
      database: 'none',
      password: 'none',
      connectionTimeoutMillis: 200,
    });
    hung.on('error', () => {});
    try {
      const res = await createApp({ appDb: hung, backend, config }).request('/healthz');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'database unavailable' });
    } finally {
      await hung.end();
      silent.close();
    }
  });

  it('answers 503 when every connection in the pool stays busy', async () => {
    const full = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 1, connectionTimeoutMillis: 200 });
    const holder = await full.connect();
    try {
      const res = await createApp({ appDb: full, backend, config }).request('/healthz');
      expect(res.status).toBe(503);
    } finally {
      holder.release();
      await full.end();
    }
  });

  it('answers unknown paths with a JSON 404', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

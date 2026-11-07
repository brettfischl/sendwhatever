import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createUser } from '../src/admin/users.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { encryptJson, generateApiKey, hashApiKey } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });
const dataUrl = new URL(config.dataDatabaseUrl);
const connection = {
  host: dataUrl.hostname,
  port: Number(dataUrl.port),
  database: dataUrl.pathname.slice(1),
};
const credentials = {
  user: decodeURIComponent(dataUrl.username),
  password: decodeURIComponent(dataUrl.password),
};

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const HOSTILE_TABLE = '<img src=x onerror=alert(1)>';
const namespaces: string[] = [];
const accountIds: string[] = [];
const userIds: string[] = [];

interface Seeded {
  id: string;
  slug: string;
  storeId: string;
  readKey: string;
  ingestKey: string;
}

async function addKey(accountId: string, scope: 'ingest' | 'read'): Promise<string> {
  const key = generateApiKey();
  await appDb.query('INSERT INTO api_keys (account_id, key_hash, scope) VALUES ($1, $2, $3)', [
    accountId,
    hashApiKey(key),
    scope,
  ]);
  return key;
}

async function newAccount(label: string, { reachable = true } = {}): Promise<Seeded> {
  const slug = `ta-${label}-${tag}`;
  const namespace = `t_${randomBytes(6).toString('hex')}_ta`;
  namespaces.push(namespace);
  const read = await backend.provision({ namespace, connection, credentials });
  const id = (
    await appDb.query<{ id: string }>(
      `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
      [slug],
    )
  ).rows[0]!.id;
  accountIds.push(id);
  const storeId = (
    await appDb.query<{ id: string }>(
      `INSERT INTO account_stores
         (account_id, generation, backend, connection, credentials, read_credentials, namespace, status)
       VALUES ($1, 1, 'postgres', $2, $3, $4, $5, 'active') RETURNING id`,
      [
        id,
        JSON.stringify(reachable ? connection : { ...connection, port: 1 }),
        encryptJson(config.encryptionKey, credentials),
        encryptJson(config.encryptionKey, read),
        namespace,
      ],
    )
  ).rows[0]!.id;
  return { id, slug, storeId, readKey: await addKey(id, 'read'), ingestKey: await addKey(id, 'ingest') };
}

const COLUMNS = {
  title: 'string',
  price: 'number',
  active: 'boolean',
  placed_at: 'timestamp',
  extra: 'json',
} as const;

async function register(a: Seeded, table: string, columns: Record<string, string>) {
  for (const [column, type] of Object.entries({ id: 'string', ...columns })) {
    await appDb.query(
      'INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, $2, $3, $4)',
      [a.storeId, table, column, type],
    );
  }
}

const tables = (a: Seeded, path: string, key: string | undefined = a.readKey) =>
  app.request(`/tables/${path}`, {
    headers: {
      'x-account-slug': a.slug,
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
  });

let a: Seeded;
let b: Seeded;
let member: { cookie: string };
let outsider: { cookie: string };
let superAdmin: { cookie: string };

async function login(label: string, isSuperAdmin = false) {
  const email = `${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  const res = await app.request('http://localhost/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
  });
  expect(res.status).toBe(303);
  return {
    id,
    cookie: `sw_admin=${/sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`,
  };
}

const admin = (path: string, session?: { cookie: string }) =>
  app.request(path, { headers: session ? { cookie: session.cookie } : {} });

beforeAll(async () => {
  a = await newAccount('a');
  b = await newAccount('b');
  await register(a, 'orders', COLUMNS);
  await register(a, 'order_items', { orders_id: 'string' });
  await register(b, 'secrets', { value: 'string' });
  await register(a, HOSTILE_TABLE, { '"><script>alert(1)</script>': 'string' });

  const store = { namespace: namespaces[0]!, connection, credentials };
  const storeB = { namespace: namespaces[1]!, connection, credentials };
  await backend.applySchema(store, [
    { kind: 'create_table', table: 'orders' },
    ...Object.entries(COLUMNS).map(([column, type]) => ({
      kind: 'add_column' as const,
      table: 'orders',
      column,
      type,
    })),
    // In the store but not the registry, so the API must not reach it.
    { kind: 'create_table', table: 'unregistered' },
  ]);
  await backend.applySchema(storeB, [
    { kind: 'create_table', table: 'secrets' },
    { kind: 'add_column', table: 'secrets', column: 'value', type: 'string' },
  ]);
  await backend.write(store, [
    {
      table: 'orders',
      columns: { ...COLUMNS },
      rows: [
        {
          id: 'o1',
          _event_seq: '1',
          title: 'first',
          price: 12.5,
          active: true,
          placed_at: '2026-01-02T03:04:05.123456Z',
          extra: { nested: [1, 2] },
        },
        { id: 'o2', _event_seq: '2', title: 'second', price: 9007199254740991 },
        { id: 'o3', _event_seq: '3', title: 'gone', _deleted_at: '2026-01-01T00:00:00Z' },
        { id: 'o4', _event_seq: '4', title: 'fourth' },
        { id: 'a/b:c', _event_seq: '5', title: 'odd id' },
      ],
    },
  ]);

  const memberLogin = await login('member');
  member = memberLogin;
  await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [
    a.id,
    memberLogin.id,
  ]);
  outsider = await login('outsider');
  superAdmin = await login('super', true);
});

afterAll(async () => {
  await appDb.query('DELETE FROM account_members WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query(
    'DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = ANY($1))',
    [accountIds],
  );
  await appDb.query('DELETE FROM api_keys WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM account_stores WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await backend.close();
  const admin = new pg.Client({ connectionString: config.dataDatabaseUrl });
  await admin.connect();
  for (const namespace of namespaces) {
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
  await admin.end();
  await appDb.end();
});

describe('reading rows', () => {
  it('returns live rows in id order, without platform columns', async () => {
    const res = await tables(a, 'orders');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Record<string, unknown>[]; next_after: unknown };
    expect(body.rows.map((r) => r.id).sort()).toEqual(['a/b:c', 'o1', 'o2', 'o4']);
    expect(body.next_after).toBeNull();
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...Object.keys(COLUMNS), 'id'].sort());
    }
  });

  it('keeps each type exact', async () => {
    const o1 = (await (await tables(a, 'orders/o1')).json()) as Record<string, unknown>;
    expect(o1).toMatchObject({ price: 12.5, active: true, extra: { nested: [1, 2] } });
    expect(new Date(o1.placed_at as string).getTime()).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 123));
    expect(o1.placed_at).toContain('.123456');
    const o2 = (await (await tables(a, 'orders/o2')).json()) as Record<string, unknown>;
    expect(o2.price).toBe(9007199254740991);
    expect(o2.active).toBeNull();
  });

  it('pages through every row exactly once', async () => {
    const seen: unknown[] = [];
    let after: string | null = null;
    do {
      const query: string = after ? `&after=${encodeURIComponent(after)}` : '';
      const body = (await (await tables(a, `orders?limit=3${query}`)).json()) as {
        rows: { id: string }[];
        next_after: string | null;
      };
      expect(body.rows.length).toBeLessThanOrEqual(3);
      seen.push(...body.rows.map((r) => r.id));
      after = body.next_after;
    } while (after);
    expect(seen.slice().sort()).toEqual(['a/b:c', 'o1', 'o2', 'o4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('finds an id with special characters, and 404s a deleted or unknown row', async () => {
    const odd = await tables(a, `orders/${encodeURIComponent('a/b:c')}`);
    expect(odd.status).toBe(200);
    expect(((await odd.json()) as { title: string }).title).toBe('odd id');
    expect((await tables(a, 'orders/o3')).status).toBe(404);
    expect((await tables(a, 'orders/nope')).status).toBe(404);
  });

  it.each(['0', '-1', '1001', '1.5', 'abc', '99999999999999999999', '1;drop'])(
    'refuses limit=%s',
    async (limit) => {
      expect((await tables(a, `orders?limit=${encodeURIComponent(limit)}`)).status).toBe(400);
    },
  );

  it('refuses a NUL in an id or cursor instead of failing the query', async () => {
    expect((await tables(a, 'orders/a%00b')).status).toBe(400);
    expect((await tables(a, 'orders?after=a%00b')).status).toBe(400);
  });

  it('only reaches tables in the registry', async () => {
    for (const name of ['unregistered', 'pg_authid', 'pg_catalog.pg_class', 'orders"; DROP TABLE orders; --']) {
      expect((await tables(a, encodeURIComponent(name))).status).toBe(404);
    }
    expect((await tables(a, 'orders')).status).toBe(200);
  });

  it('answers 503 with no detail when the store is unreachable', async () => {
    const down = await newAccount('down', { reachable: false });
    await register(down, 'orders', { title: 'string' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await tables(down, 'orders');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'table data is unavailable' });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('key scopes', () => {
  it('refuses an ingest key on the read API', async () => {
    const res = await tables(a, 'orders', a.ingestKey);
    expect(res.status).toBe(401);
  });

  it('refuses a read key on ingest', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: {
        'x-account-slug': a.slug,
        authorization: `Bearer ${a.readKey}`,
        'content-type': 'application/json',
      },
      body: '{"a":1}',
    });
    expect(res.status).toBe(401);
  });

  it('still accepts an ingest key on ingest', async () => {
    const res = await app.request('/ingest', {
      method: 'POST',
      headers: {
        'x-account-slug': b.slug,
        authorization: `Bearer ${b.ingestKey}`,
        'content-type': 'application/json',
      },
      body: '{"a":1}',
    });
    expect(res.status).toBeLessThan(300);
    await appDb.query('DELETE FROM queue WHERE account_id = $1', [b.id]);
    await appDb.query('DELETE FROM events WHERE account_id = $1', [b.id]);
  });

  it('refuses a key in the URL, a missing key, and a revoked key', async () => {
    const inUrl = await app.request(`/tables/orders?key=${a.readKey}`, {
      headers: { 'x-account-slug': a.slug },
    });
    expect(inUrl.status).toBe(401);
    expect((await tables(a, 'orders', '')).status).toBe(401);

    const revoked = await addKey(a.id, 'read');
    await appDb.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashApiKey(revoked)]);
    expect((await tables(a, 'orders', revoked)).status).toBe(401);
  });

  it("keeps accounts apart: another account's key or table gets nothing", async () => {
    expect((await tables(a, 'orders', b.readKey)).status).toBe(401);
    expect((await tables(b, 'orders')).status).toBe(404);
    expect((await tables(a, 'secrets')).status).toBe(404);
  });

  it('refuses a disabled account', async () => {
    const disabled = await newAccount('disabled');
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [disabled.id]);
    expect((await tables(disabled, 'orders')).status).toBe(403);
  });

  it('only allows the known scopes', async () => {
    await expect(
      appDb.query('INSERT INTO api_keys (account_id, key_hash, scope) VALUES ($1, $2, $3)', [
        a.id,
        hashApiKey(generateApiKey()),
        'admin',
      ]),
    ).rejects.toThrow(/check/i);
  });
});

describe('table docs', () => {
  const specPath = (table = 'orders') =>
    `/admin/accounts/${a.id}/schema/${encodeURIComponent(table)}/openapi.json`;
  const docsPath = (table = 'orders') =>
    `/admin/accounts/${a.id}/schema/${encodeURIComponent(table)}/docs`;

  it('describes the live columns and the paths that really exist', async () => {
    const res = await admin(specPath(), member);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as any;
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(['/tables/orders', '/tables/orders/{id}']);
    expect(spec.components.schemas.Row.properties).toEqual({
      id: { type: 'string' },
      title: { type: ['string', 'null'] },
      price: { type: ['number', 'null'] },
      active: { type: ['boolean', 'null'] },
      placed_at: { type: ['string', 'null'], format: 'date-time' },
      extra: {},
    });
    expect(spec.security).toEqual([{ readKey: [] }]);

    // The rows the API returns have exactly the documented keys.
    const row = (await (await tables(a, 'orders/o1')).json()) as object;
    expect(Object.keys(row).sort()).toEqual(Object.keys(spec.components.schemas.Row.properties).sort());
  });

  it('marks a column that refers to a parent table', async () => {
    await register(a, 'orders_links', { orders_id: 'string' });
    const spec = (await (await admin(specPath('orders_links'), member)).json()) as any;
    expect(spec.components.schemas.Row.properties.orders_id['x-references']).toBe('orders');
  });

  it('keeps client names out of Markdown and component names', async () => {
    const spec = (await (await admin(specPath(HOSTILE_TABLE), member)).json()) as any;
    expect(Object.keys(spec.paths)[0]).toBe(`/tables/${encodeURIComponent(HOSTILE_TABLE)}`);
    expect(Object.keys(spec.components.schemas).sort()).toEqual(['Error', 'Row', 'RowPage']);
    expect(spec.info.description).not.toContain('<');
    for (const operation of Object.values(spec.paths) as any[]) {
      expect(JSON.stringify(operation.get.summary)).not.toContain('<');
    }
  });

  it('escapes a hostile table name on the docs and schema pages, and sets a strict CSP', async () => {
    const res = await admin(docsPath(HOSTILE_TABLE), member);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).not.toContain('<img src=x');
    expect(page.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(page).not.toMatch(/https?:\/\//);

    const schema = await (await admin(`/admin/accounts/${a.id}/schema`, member)).text();
    expect(schema).not.toContain('<img src=x');
  });

  it('links to the docs from the schema page', async () => {
    const schema = await (await admin(`/admin/accounts/${a.id}/schema`, member)).text();
    expect(schema).toContain(docsPath());
  });

  it("hides another account's tables and pages", async () => {
    expect((await admin(specPath(), outsider)).status).toBe(404);
    expect((await admin(docsPath(), outsider)).status).toBe(404);
    expect((await admin(specPath('secrets'), member)).status).toBe(404);
    expect((await admin(docsPath('secrets'), member)).status).toBe(404);
    expect((await admin(`/admin/accounts/${b.id}/schema/secrets/openapi.json`, member)).status).toBe(404);
  });

  it('needs a login, for the spec and the assets', async () => {
    for (const path of [specPath(), docsPath(), '/admin/assets/swagger/swagger-ui-bundle.js']) {
      expect((await admin(path)).status).toBe(303);
    }
  });

  it('lets a super admin read the spec, which shows no row data', async () => {
    expect((await admin(specPath(), superAdmin)).status).toBe(200);
  });

  it('serves only the known Swagger files', async () => {
    const js = await admin('/admin/assets/swagger/swagger-ui-bundle.js', member);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect((await js.text()).length).toBeGreaterThan(100_000);
    const css = await admin('/admin/assets/swagger/swagger-ui.css', member);
    expect(css.headers.get('content-type')).toContain('text/css');
    const init = await admin('/admin/assets/swagger/init.js', member);
    expect(await init.text()).toContain('validatorUrl: null');
    for (const name of ['package.json', 'constructor', '..%2F..%2Fpackage.json', 'index.html']) {
      expect((await admin(`/admin/assets/swagger/${name}`, member)).status).toBe(404);
    }
  });
});

describe('creating keys in the admin', () => {
  async function csrfOf(session: { cookie: string }) {
    const html = await (await admin(`/admin/accounts/${a.id}/credentials`, session)).text();
    return /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
  }

  async function create(scope: string | undefined) {
    const before = await appDb.query<{ id: string }>('SELECT id FROM api_keys WHERE account_id = $1', [a.id]);
    const res = await app.request(`http://localhost/admin/accounts/${a.id}/credentials/keys`, {
      method: 'POST',
      headers: {
        cookie: member.cookie,
        origin: 'http://localhost',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        _csrf: await csrfOf(member),
        ...(scope ? { scope } : {}),
      }).toString(),
    });
    expect(res.status).toBe(200);
    const { rows } = await appDb.query<{ scope: string }>(
      'SELECT scope FROM api_keys WHERE account_id = $1 AND NOT (id = ANY($2))',
      [a.id, before.rows.map((r) => r.id)],
    );
    return { page: await res.text(), scope: rows[0]!.scope };
  }

  it('creates a read key that works on the API', async () => {
    const { page, scope } = await create('read');
    expect(scope).toBe('read');
    expect(page).toContain('New read-only API key');
    const key = /<code>([^<]+)<\/code>/.exec(page)![1]!;
    expect((await tables(a, 'orders', key)).status).toBe(200);
  });

  it('creates an ingest key by default, and for an unknown scope', async () => {
    expect((await create(undefined)).scope).toBe('ingest');
    expect((await create('admin')).scope).toBe('ingest');
  });

  it('shows the scope, and offers both buttons', async () => {
    const page = await (await admin(`/admin/accounts/${a.id}/credentials`, member)).text();
    expect(page).toContain('read-only</span>');
    expect(page).toContain('Create read-only API key');
  });

  it('does not let a read-only super admin create a key', async () => {
    const html = await (await admin(`/admin/accounts/${a.id}/credentials`, superAdmin)).text();
    expect(html).not.toContain('Create read-only API key');
  });
});

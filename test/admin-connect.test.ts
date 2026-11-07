import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccount } from '../src/accounts/create.js';
import { createUser } from '../src/admin/users.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { hashApiKey } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const ORIGIN = 'http://localhost';
const userIds: string[] = [];
const accountIds: string[] = [];

async function newUser(label: string, isSuperAdmin = false) {
  const email = `${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  return { id, email };
}

async function newAccount(label: string) {
  const created = await createAccount({ appDb, backend, config }, { slug: `cc-${label}-${tag}` });
  accountIds.push(created.accountId);
  return created;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function session(email: string) {
  const res = await app.request(`${ORIGIN}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: form({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(303);
  const cookie = /sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  const headers = { cookie: `sw_admin=${cookie}` };
  const html = await (await app.request('/admin', { headers })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
  return { headers, csrf };
}
type Session = Awaited<ReturnType<typeof session>>;

const get = (path: string, s: Session) => app.request(path, { headers: s.headers });
const post = (path: string, s: Session) =>
  app.request(path, {
    method: 'POST',
    headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: form({ _csrf: s.csrf }),
  });

const ingest = (slug: string, key: string) =>
  app.request('/ingest/orders', {
    method: 'POST',
    headers: {
      'x-account-slug': slug,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: 1 }),
  });

const KEY_RE = /sw_[A-Za-z0-9_-]{43}/;

let owner: Awaited<ReturnType<typeof newUser>>;
let ownerSession: Session;
let acct: Awaited<ReturnType<typeof newAccount>>;
let other: Awaited<ReturnType<typeof newAccount>>;

beforeAll(async () => {
  owner = await newUser('owner');
  acct = await newAccount('a');
  other = await newAccount('b');
  await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [
    acct.accountId,
    owner.id,
  ]);
  ownerSession = await session(owner.email);
});

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'postgres',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  for (const id of accountIds) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
    for (const table of ['quarantine', 'queue', 'events', 'api_keys', 'account_stores']) {
      await appDb.query(`DELETE FROM ${table} WHERE account_id = $1`, [id]);
    }
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.end();
});

describe('connect page', () => {
  it('shows the endpoint, a curl example, the webhook template, and no password', async () => {
    const res = await get(`/admin/accounts/${acct.accountId}/connect`, ownerSession);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain(`http://localhost:${config.port}/ingest`);
    expect(html).toContain(`X-Account-Slug: ${acct.slug}`);
    expect(html).toContain('Bearer $API_KEY');
    expect(html).toContain('/ingest/&lt;source&gt;?key=&lt;API_KEY&gt;');
    expect(html).toContain(
      `postgres://${acct.database.user}@localhost:${config.postgresPort}/${acct.database.database}`,
    );
    expect(html).not.toContain(String(acct.database.password));
    expect(html).not.toContain(acct.apiKey);
  });
});

describe('credentials', () => {
  it('creates a key that works, shows it once, and revokes it', async () => {
    const base = `/admin/accounts/${acct.accountId}/credentials`;
    const created = await post(`${base}/keys`, ownerSession);
    expect(created.status).toBe(200);
    expect(created.headers.get('location')).toBeNull();
    expect(created.headers.get('cache-control')).toBe('no-store');
    const key = KEY_RE.exec(await created.text())![0];

    expect((await ingest(acct.slug, key)).status).toBe(202);

    const list = await (await get(base, ownerSession)).text();
    expect(list).not.toContain(key);
    expect(list).toContain('Revoke');

    const { rows } = await appDb.query<{ id: string; key_hash: string }>(
      `SELECT id, key_hash FROM api_keys WHERE account_id = $1 AND key_hash LIKE $2`,
      [acct.accountId, `${hashApiKey(key).slice(0, 8)}%`],
    );
    expect(rows).toHaveLength(1);
    expect(list).toContain(rows[0]!.key_hash.slice(0, 8));
    expect(list).not.toContain(rows[0]!.key_hash);

    const revoked = await post(`${base}/keys/${rows[0]!.id}/revoke`, ownerSession);
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get('location')).toBe(base);
    expect(revoked.headers.get('location')).not.toContain(key);
    expect((await ingest(acct.slug, key)).status).toBe(401);
    expect(await (await get(base, ownerSession)).text()).toContain('revoked');
  });

  it("returns 404 when revoking another account's key", async () => {
    const { rows } = await appDb.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE account_id = $1',
      [other.accountId],
    );
    const path = `/admin/accounts/${acct.accountId}/credentials/keys/${rows[0]!.id}/revoke`;
    expect((await post(path, ownerSession)).status).toBe(404);
    expect((await ingest(other.slug, other.apiKey)).status).toBe(202);
    const bad = `/admin/accounts/${acct.accountId}/credentials/keys/not-a-uuid/revoke`;
    expect((await post(bad, ownerSession)).status).toBe(404);
  });

  it('reveals a read-only login that connects, only on POST', async () => {
    const path = `/admin/accounts/${acct.accountId}/credentials/reveal`;
    expect((await get(path, ownerSession)).status).toBe(404);

    const res = await post(path, ownerSession);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    const { user, password, database } = acct.database;
    expect(html).toContain(String(user));
    expect(html).toContain(String(password));
    expect(html).toContain('aria-label="Copy password"');
    expect(html).toContain(
      `postgres://${user}:${encodeURIComponent(String(password))}@localhost:${config.postgresPort}/${database}`,
    );

    const client = new pg.Client({
      host: 'localhost',
      port: config.postgresPort,
      user: String(user),
      password: String(password),
      database: String(database),
    });
    await client.connect();
    try {
      expect((await client.query('SELECT 1 AS one')).rows[0]).toEqual({ one: 1 });
    } finally {
      await client.end();
    }
  });

  it('blocks create, revoke and reveal for a super admin but lets them read', async () => {
    const admin = await newUser('super', true);
    const s = await session(admin.email);
    const base = `/admin/accounts/${acct.accountId}`;
    expect((await get(`${base}/connect`, s)).status).toBe(200);
    const page = await get(`${base}/credentials`, s);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('Create API key');
    expect(html).not.toContain('Reveal login');
    expect(html).toContain('requires account membership');
    expect(html).toContain(`href="/admin/manage/accounts/${acct.accountId}"`);

    const { rows } = await appDb.query<{ id: string }>(
      'SELECT id FROM api_keys WHERE account_id = $1 LIMIT 1',
      [acct.accountId],
    );
    const before = (await appDb.query('SELECT 1 FROM api_keys WHERE account_id = $1', [acct.accountId]))
      .rowCount;
    expect((await post(`${base}/credentials/keys`, s)).status).toBe(403);
    expect((await post(`${base}/credentials/keys/${rows[0]!.id}/revoke`, s)).status).toBe(403);
    expect((await post(`${base}/credentials/reveal`, s)).status).toBe(403);
    const after = (await appDb.query('SELECT 1 FROM api_keys WHERE account_id = $1', [acct.accountId]))
      .rowCount;
    expect(after).toBe(before);
  });
});

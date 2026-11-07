import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../src/admin/index.js';
import { createUser, verifyPassword } from '../src/admin/users.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const app = createApp({ appDb, backend: new PostgresBackend({ idleTimeoutMs: 50 }), config });

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const ORIGIN = 'http://localhost';
const userIds: string[] = [];
const slugs: string[] = [];

async function newUser(label: string, isSuperAdmin = false) {
  const email = `${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  return { id, email };
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function session(email: string, password = PASSWORD) {
  const res = await app.request(`${ORIGIN}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: form({ email, password }),
  });
  expect(res.status).toBe(303);
  const cookie = /sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  const headers = { cookie: `sw_admin=${cookie}` };
  const html = await (await app.request('/admin', { headers })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
  return { headers, csrf };
}
type Session = Awaited<ReturnType<typeof session>>;

function post(path: string, s: Session, fields: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: form({ _csrf: s.csrf, ...fields }),
  });
}

const ingest = (slug: string, key: string) =>
  app.request('/ingest/things', {
    method: 'POST',
    headers: { 'x-account-slug': slug, authorization: `Bearer ${key}` },
    body: '{"id":1}',
  });

const sessionCount = async (userId: string) =>
  (await appDb.query('SELECT 1 FROM sessions WHERE user_id = $1', [userId])).rowCount;

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
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
    for (const table of ['quarantine', 'queue', 'events', 'api_keys', 'account_members', 'account_stores']) {
      await appDb.query(`DELETE FROM ${table} WHERE account_id = $1`, [id]);
    }
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.end();
});

describe('manage accounts', () => {
  it('creates an account (key shown once, works), disables and re-enables it, and manages members', async () => {
    const admin = await newUser('acct-admin', true);
    const member = await newUser('acct-member');
    const s = await session(admin.email);
    const slug = `mg-${tag}`;
    slugs.push(slug);

    const created = await post('/admin/manage/accounts', s, { slug });
    expect(created.status).toBe(200);
    expect(created.headers.get('location')).toBeNull();
    expect(created.headers.get('cache-control')).toBe('no-store');
    const html = await created.text();
    const apiKey = /sw_[A-Za-z0-9_-]{20,}/.exec(html)![0];
    expect(html).toContain('shown once');
    expect(html).toContain('Read-only database login');

    expect((await ingest(slug, apiKey)).status).toBe(202);

    // The key is not shown again anywhere.
    const { rows } = await appDb.query<{ id: string; status: string }>(
      'SELECT id, status FROM accounts WHERE slug = $1',
      [slug],
    );
    const id = rows[0]!.id;
    expect(rows[0]!.status).toBe('active');
    const list = await (await app.request('/admin/manage/accounts', { headers: s.headers })).text();
    expect(list).toContain(slug);
    const detail = await (await app.request(`/admin/manage/accounts/${id}`, { headers: s.headers })).text();
    expect(detail).not.toContain(apiKey);

    // Disable: ingest is refused, then re-enable.
    const off = await post(`/admin/manage/accounts/${id}/disable`, s);
    expect(off.status).toBe(303);
    expect(off.headers.get('location')).toBe(`/admin/manage/accounts/${id}`);
    expect((await ingest(slug, apiKey)).status).toBe(403);
    const on = await post(`/admin/manage/accounts/${id}/enable`, s);
    expect(on.status).toBe(303);
    expect((await ingest(slug, apiKey)).status).toBe(202);

    // Membership: the user gains and loses access to the account's pages.
    const m = await session(member.email);
    expect((await app.request(`/admin/accounts/${id}`, { headers: m.headers })).status).toBe(404);
    const added = await post(`/admin/manage/accounts/${id}/members`, s, {
      email: member.email.toUpperCase(),
    });
    expect(added.status).toBe(303);
    expect((await app.request(`/admin/accounts/${id}`, { headers: m.headers })).status).toBe(200);
    const withMember = await (await app.request(`/admin/manage/accounts/${id}`, { headers: s.headers })).text();
    expect(withMember).toContain(member.email);
    const removed = await post(`/admin/manage/accounts/${id}/members/${member.id}/remove`, s);
    expect(removed.status).toBe(303);
    expect((await app.request(`/admin/accounts/${id}`, { headers: m.headers })).status).toBe(404);
  });

  it('maps account errors to friendly messages', async () => {
    const admin = await newUser('acct-errors', true);
    const s = await session(admin.email);

    const bad = await post('/admin/manage/accounts', s, { slug: 'Not A Slug' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Invalid slug');

    const taken = `mgx-${tag}`;
    slugs.push(taken);
    await appDb.query(`INSERT INTO accounts (slug, status) VALUES ($1, 'active')`, [taken]);
    const dup = await post('/admin/manage/accounts', s, { slug: taken });
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain('already exists');
  });

  it('refuses to disable an account that is still provisioning', async () => {
    const admin = await newUser('acct-prov', true);
    const s = await session(admin.email);
    const slug = `mgp-${tag}`;
    slugs.push(slug);
    const { rows } = await appDb.query<{ id: string }>(
      `INSERT INTO accounts (slug, status) VALUES ($1, 'provisioning') RETURNING id`,
      [slug],
    );
    const res = await post(`/admin/manage/accounts/${rows[0]!.id}/disable`, s);
    expect(res.status).toBe(409);
    const { rows: after } = await appDb.query('SELECT status FROM accounts WHERE id = $1', [rows[0]!.id]);
    expect(after[0].status).toBe('provisioning');
  });

  it('answers a friendly error for an unknown member email', async () => {
    const admin = await newUser('acct-nomember', true);
    const s = await session(admin.email);
    const slug = `mgm-${tag}`;
    slugs.push(slug);
    const { rows } = await appDb.query<{ id: string }>(
      `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
      [slug],
    );
    const res = await post(`/admin/manage/accounts/${rows[0]!.id}/members`, s, {
      email: `nobody-${tag}@example.test`,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('No user has that email');
  });
});

describe('manage users', () => {
  it('creates a user who can sign in, with friendly errors for duplicates and short passwords', async () => {
    const admin = await newUser('usr-admin', true);
    const s = await session(admin.email);
    const email = `created-${tag}@example.test`;

    const ok = await post('/admin/manage/users', s, { email, password: PASSWORD });
    expect(ok.status).toBe(303);
    const row = (await appDb.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]))
      .rows[0]!;
    userIds.push(row.id);
    await session(email);

    const dup = await post('/admin/manage/users', s, { email: email.toUpperCase(), password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain('already exists');

    const short = await post('/admin/manage/users', s, { email: `short-${tag}@example.test`, password: 'short' });
    expect(short.status).toBe(400);
    const shortHtml = await short.text();
    expect(shortHtml).toContain('at least 12 characters');
    expect(shortHtml).not.toContain('value="short"');
    expect(
      (await appDb.query('SELECT 1 FROM users WHERE email = $1', [`short-${tag}@example.test`])).rowCount,
    ).toBe(0);

    const list = await (await app.request('/admin/manage/users', { headers: s.headers })).text();
    expect(list).toContain(email);
  });

  it('disables a user and ends their sessions, but never the acting super admin', async () => {
    const admin = await newUser('usr-disabler', true);
    const victim = await newUser('usr-victim');
    const s = await session(admin.email);
    const v = await session(victim.email);
    expect(await sessionCount(victim.id)).toBeGreaterThan(0);

    const res = await post(`/admin/manage/users/${victim.id}/disable`, s);
    expect(res.status).toBe(303);
    expect(await sessionCount(victim.id)).toBe(0);
    expect((await app.request('/admin', { headers: v.headers })).status).toBe(303);
    const { rows } = await appDb.query('SELECT disabled_at FROM users WHERE id = $1', [victim.id]);
    expect(rows[0].disabled_at).not.toBeNull();

    const self = await post(`/admin/manage/users/${admin.id}/disable`, s);
    expect(self.status).toBe(400);
    expect(await self.text()).toContain('cannot disable your own');
    const { rows: me } = await appDb.query('SELECT disabled_at FROM users WHERE id = $1', [admin.id]);
    expect(me[0].disabled_at).toBeNull();
  });

  it('resets a password: sessions end, the new password works, and it is never echoed', async () => {
    const admin = await newUser('usr-reset-admin', true);
    const target = await newUser('usr-reset-target');
    const s = await session(admin.email);
    await session(target.email);
    expect(await sessionCount(target.id)).toBeGreaterThan(0);

    const fresh = 'a brand new passphrase';
    const res = await post(`/admin/manage/users/${target.id}/password`, s, { password: fresh });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/manage/users');
    expect(await res.text()).not.toContain(fresh);
    expect(await sessionCount(target.id)).toBe(0);
    const { rows } = await appDb.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [target.id],
    );
    expect(await verifyPassword(fresh, rows[0]!.password_hash)).toBe(true);
    await session(target.email, fresh);

    const weak = await post(`/admin/manage/users/${target.id}/password`, s, { password: 'tiny' });
    expect(weak.status).toBe(400);
    expect(await weak.text()).toContain('at least 12 characters');
  });
});

describe('access control and secrets', () => {
  it('answers 404 to a non-super-admin on every registered /manage route', async () => {
    const member = await newUser('guard-member');
    const m = await session(member.email);
    const uuid = '00000000-0000-4000-8000-000000000000';

    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const entries = new Set<string>(['GET /manage/__later', 'POST /manage/__later']);
    for (const r of adminRoutes.routes) {
      if (!r.path.startsWith('/manage/')) continue;
      for (const method of r.method === 'ALL' ? METHODS : [r.method]) entries.add(`${method} ${r.path}`);
    }
    // The pages from this ticket are registered, so the loop is not vacuous.
    expect(entries.size).toBeGreaterThan(10);

    for (const entry of entries) {
      const [method, path] = entry.split(' ') as [string, string];
      const url = '/admin' + path.replace(/:\w+/g, uuid).replace('*', 'x');
      const res = await app.request(url, {
        method,
        headers: { ...m.headers, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: method === 'GET' ? undefined : form({ _csrf: m.csrf, slug: `deny-${tag}`, email: 'x@y.z', password: PASSWORD }),
      });
      expect(res.status, entry).toBe(404);
    }
    expect((await appDb.query('SELECT 1 FROM accounts WHERE slug = $1', [`deny-${tag}`])).rowCount).toBe(0);
  });

  it('never puts a secret in a Location header', async () => {
    const admin = await newUser('secrets-admin', true);
    const s = await session(admin.email);
    const slug = `mgs-${tag}`;
    slugs.push(slug);
    const res = await post('/admin/manage/accounts', s, { slug });
    expect(res.headers.get('location')).toBeNull();
    const target = await newUser('secrets-target');
    const pw = 'secret passphrase 123';
    const reset = await post(`/admin/manage/users/${target.id}/password`, s, { password: pw });
    expect(reset.headers.get('location') ?? '').not.toContain('passphrase');
    const created = await post('/admin/manage/users', s, { email: `sec-${tag}@example.test`, password: pw });
    expect(created.headers.get('location') ?? '').not.toContain('passphrase');
    const { rows } = await appDb.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [
      `sec-${tag}@example.test`,
    ]);
    if (rows[0]) userIds.push(rows[0].id);
  });
});

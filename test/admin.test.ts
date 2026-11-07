import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { adminRoutes } from '../src/admin/index.js';
import {
  createUser,
  disableUser,
  ensureSuperAdmin,
  hashPassword,
  setPassword,
  UserError,
  verifyPassword,
} from '../src/admin/users.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const app = createApp({ appDb, backend: new PostgresBackend(), config });

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

async function newAccount(label: string, status = 'active') {
  const { rows } = await appDb.query<{ id: string }>(
    'INSERT INTO accounts (slug, status) VALUES ($1, $2) RETURNING id',
    [`adm-${label}-${tag}`, status],
  );
  accountIds.push(rows[0]!.id);
  return { id: rows[0]!.id, slug: `adm-${label}-${tag}` };
}

const addMember = (accountId: string, userId: string) =>
  appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [
    accountId,
    userId,
  ]);

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

async function loginResponse(email: string, password = PASSWORD, origin = ORIGIN) {
  return app.request(`${origin}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: form({ email, password }),
  });
}

/** Logs in and returns the cookie header to send back plus the page's CSRF token. */
async function session(email: string) {
  const res = await loginResponse(email);
  expect(res.status).toBe(303);
  const cookie = /sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  const headers = { cookie: `sw_admin=${cookie}` };
  const html = await (await app.request('/admin', { headers })).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)![1]!;
  return { cookie, headers, csrf };
}

type Session = Awaited<ReturnType<typeof session>>;

function post(path: string, s: Session, fields: Record<string, string> = {}, origin = ORIGIN) {
  return app.request(path, {
    method: 'POST',
    headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin },
    body: form(fields),
  });
}

afterAll(async () => {
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

describe('login and sessions', () => {
  it('logs in, lists the member accounts, and logs out', async () => {
    const user = await newUser('member');
    const mine = await newAccount('mine');
    const other = await newAccount('other');
    await addMember(mine.id, user.id);

    const s = await session(user.email);
    const home = await app.request('/admin', { headers: s.headers });
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(mine.slug);
    expect(html).not.toContain(other.slug);

    const out = await post('/admin/logout', s, { _csrf: s.csrf });
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/admin/login');
    const { rowCount } = await appDb.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id]);
    expect(rowCount).toBe(0);

    const after = await app.request('/admin', { headers: s.headers });
    expect(after.status).toBe(303);
    expect(after.headers.get('location')).toBe('/admin/login');
  });

  it('gives the same error for an unknown email and a wrong password', async () => {
    const user = await newUser('wrongpw');
    const wrong = await loginResponse(user.email, 'not the password');
    const unknown = await loginResponse(`nobody-${tag}@example.test`);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a disabled user at login', async () => {
    const user = await newUser('disabled-login');
    await disableUser(appDb, user.id);
    expect((await loginResponse(user.email)).status).toBe(401);
  });

  it('sends an expired session back to login', async () => {
    const user = await newUser('expired');
    const s = await session(user.email);
    await appDb.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
      [user.id],
    );
    const res = await app.request('/admin', { headers: s.headers });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/login');
  });

  it('cuts off a disabled user at once and deletes their sessions', async () => {
    const user = await newUser('disabled');
    const s = await session(user.email);
    expect((await app.request('/admin', { headers: s.headers })).status).toBe(200);

    await disableUser(appDb, user.id);
    const res = await app.request('/admin', { headers: s.headers });
    expect(res.status).toBe(303);
    const { rowCount } = await appDb.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id]);
    expect(rowCount).toBe(0);
  });

  it('ends sessions when the password changes', async () => {
    const user = await newUser('reset');
    const s = await session(user.email);
    await setPassword(appDb, user.id, 'a brand new password');
    expect((await app.request('/admin', { headers: s.headers })).status).toBe(303);
  });

  it('sets a hardened cookie and stores only the token hash', async () => {
    const user = await newUser('cookie');
    const res = await loginResponse(user.email);
    const header = res.headers.get('set-cookie')!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/admin');
    expect(header).toContain('Max-Age=43200');
    expect(header).not.toContain('Secure'); // localhost

    const token = /sw_admin=([^;]+)/.exec(header)![1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    const { rows } = await appDb.query<{ token_hash: string; ttl: number }>(
      `SELECT token_hash, extract(epoch FROM expires_at - now())::int AS ttl
         FROM sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(rows[0]!.ttl).toBeGreaterThan(12 * 3600 - 60);
    expect(rows[0]!.ttl).toBeLessThanOrEqual(12 * 3600);

    const remote = await loginResponse(user.email, PASSWORD, 'https://admin.example.com');
    expect(remote.headers.get('set-cookie')).toContain('Secure');
  });

  it('renders HTML for admin errors and not-found, and never caches', async () => {
    const res = await app.request('/admin/nope');
    expect(res.status).toBe(303); // not signed in
    const user = await newUser('notfound');
    const s = await session(user.email);
    const missing = await app.request('/admin/nope', { headers: s.headers });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
    expect(missing.headers.get('cache-control')).toBe('no-store');
  });
});

describe('CSRF', () => {
  it('rejects a missing or wrong token with 403', async () => {
    const user = await newUser('csrf');
    const s = await session(user.email);
    expect((await post('/admin/logout', s)).status).toBe(403);
    expect((await post('/admin/logout', s, { _csrf: 'wrong' })).status).toBe(403);
    // A token for another session doesn't work either.
    const other = await session((await newUser('csrf-other')).email);
    expect((await post('/admin/logout', s, { _csrf: other.csrf })).status).toBe(403);
    // The session survived the refusals.
    expect((await app.request('/admin', { headers: s.headers })).status).toBe(200);
    expect((await post('/admin/logout', s, { _csrf: s.csrf })).status).toBe(303);
  });

  it('rejects a cross-origin post, including on login', async () => {
    const user = await newUser('origin');
    const s = await session(user.email);
    const evil = 'https://evil.example';
    expect((await post('/admin/logout', s, { _csrf: s.csrf }, evil)).status).toBe(403);
    expect((await loginResponse(user.email, PASSWORD, evil + '/..')).status).toBe(403);
    const res = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: evil },
      body: form({ email: user.email, password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('puts the token in every form the admin renders', async () => {
    const user = await newUser('forms');
    const s = await session(user.email);
    const html = await (await app.request('/admin', { headers: s.headers })).text();
    expect(html).toContain('action="/admin/logout"');
    expect(html).toContain(`name="_csrf" value="${s.csrf}"`);
    const login = await (await app.request('/admin/login')).text();
    expect(login).toContain('name="_csrf"');
  });
});

describe('authorization', () => {
  it('refuses a member on every account route pattern of another account', async () => {
    const owner = await newUser('owner');
    const intruder = await newUser('intruder');
    const target = await newAccount('target');
    const own = await newAccount('own');
    await addMember(target.id, owner.id);
    await addMember(own.id, intruder.id);
    const s = await session(intruder.email);

    const patterns = adminRoutes.routes
      .filter((r) => r.method !== 'ALL' && /^\/accounts\/:accountId(\/|$)/.test(r.path))
      .map((r) => ({ method: r.method, path: r.path }));
    expect(patterns.length).toBeGreaterThan(0);
    // An unregistered path under the prefix must be covered too, for pages added later.
    patterns.push({ method: 'GET', path: '/accounts/:accountId/__later' });
    patterns.push({ method: 'POST', path: '/accounts/:accountId/__later' });

    for (const { method, path } of patterns) {
      const concrete = (accountId: string) =>
        '/admin' + path.replace(':accountId', accountId).replace(/:\w+/g, 'x');
      const send = (accountId: string) =>
        app.request(concrete(accountId), {
          method,
          headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
          body: method === 'GET' ? undefined : form({ _csrf: s.csrf }),
        });
      const res = await send(target.id);
      expect(res.status, `${method} ${path} on another account`).toBe(404);
      // The account home is reachable on the member's own account, so the 404 above is authorization.
      if (method === 'GET' && path === '/accounts/:accountId') {
        expect((await send(own.id)).status).toBe(200);
      }
    }

    // Unknown and malformed ids look the same as another account's.
    expect((await app.request('/admin/accounts/not-a-uuid', { headers: s.headers })).status).toBe(404);
    const missing = await app.request('/admin/accounts/00000000-0000-4000-8000-000000000000', {
      headers: s.headers,
    });
    expect(missing.status).toBe(404);
  });

  it('lets a member use their own account', async () => {
    const user = await newUser('own-page');
    const account = await newAccount('own-page');
    await addMember(account.id, user.id);
    const s = await session(user.email);
    const res = await app.request(`/admin/accounts/${account.id}`, { headers: s.headers });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(account.slug);
    expect(html).not.toContain('read-only');
    // Not read-only: a write passes authorization (the path doesn't exist, so 404 from the app).
    const write = await post(`/admin/accounts/${account.id}/__later`, s, { _csrf: s.csrf });
    expect(write.status).toBe(404);
  });

  it('lets a super admin read any account but not change it', async () => {
    const admin = await newUser('super', true);
    const account = await newAccount('viewed');
    const s = await session(admin.email);

    const list = await (await app.request('/admin', { headers: s.headers })).text();
    expect(list).toContain(account.slug);
    const view = await app.request(`/admin/accounts/${account.id}`, { headers: s.headers });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('read-only');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.request(`/admin/accounts/${account.id}/anything`, {
        method,
        headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
        body: form({ _csrf: s.csrf }),
      });
      expect(res.status, method).toBe(403);
    }
    // An account that doesn't exist is still 404 for a super admin.
    const missing = await app.request('/admin/accounts/00000000-0000-4000-8000-000000000000', {
      headers: s.headers,
    });
    expect(missing.status).toBe(404);
  });

  it('keeps full access for a super admin who is also a member', async () => {
    const admin = await newUser('super-member', true);
    const account = await newAccount('both');
    await addMember(account.id, admin.id);
    const s = await session(admin.email);
    const write = await post(`/admin/accounts/${account.id}/__later`, s, { _csrf: s.csrf });
    expect(write.status).toBe(404);
  });

  it('hides /admin/manage from everyone but super admins', async () => {
    const member = await newUser('manage-member');
    const admin = await newUser('manage-super', true);
    const m = await session(member.email);
    const a = await session(admin.email);
    expect((await app.request('/admin/manage/anything', { headers: m.headers })).status).toBe(404);
    // For a super admin it passes the guard and reaches the 404 for an unregistered page.
    const res = await app.request('/admin/manage/anything', { headers: a.headers });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Page not found');
  });
});

describe('users', () => {
  it('round-trips a password hash and rejects short passwords', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong password!!', hash)).toBe(false);
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
    expect(await hashPassword(PASSWORD)).not.toBe(hash); // random salt

    await expect(
      createUser(appDb, { email: `short-${tag}@example.test`, password: 'only11chars' }),
    ).rejects.toThrow(UserError);
    const user = await newUser('short-reset');
    await expect(setPassword(appDb, user.id, 'too short')).rejects.toThrow(UserError);
    expect(await verifyPassword(PASSWORD, (await hashOf(user.id)))).toBe(true);
  });

  it('rejects a duplicate email regardless of case', async () => {
    const user = await newUser('dupe');
    await expect(
      createUser(appDb, { email: user.email.toUpperCase(), password: PASSWORD }),
    ).rejects.toThrow('email already in use');
  });

  it('creates the first super admin once and then does nothing', async () => {
    const supers = async () =>
      (await appDb.query('SELECT 1 FROM users WHERE is_super_admin')).rowCount ?? 0;
    const before = await supers();
    const email = `seed-${tag}@example.test`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      if (before === 0) {
        expect(await ensureSuperAdmin(appDb, undefined, undefined)).toBe(false);
        expect(warn).toHaveBeenCalled();
        expect(await ensureSuperAdmin(appDb, email, PASSWORD)).toBe(true);
        expect(await supers()).toBe(1);
        const { rows } = await appDb.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
          email,
        ]);
        userIds.push(rows[0]!.id);
      }
      // Idempotent: a super admin exists now, so nothing more is created.
      const count = await supers();
      expect(await ensureSuperAdmin(appDb, `second-${tag}@example.test`, PASSWORD)).toBe(false);
      expect(await supers()).toBe(count);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});

async function hashOf(userId: string): Promise<string> {
  const { rows } = await appDb.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.password_hash;
}

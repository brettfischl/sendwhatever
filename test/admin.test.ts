import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  adminOnError,
  adminRoutes,
  requireAccountAccess,
  requireSuperAdmin,
  type AdminEnv,
} from '../src/admin/index.js';
import { SESSION_COOKIE, loadSession } from '../src/admin/sessions.js';
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
    const res = await app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: evil },
      body: form({ email: user.email, password: PASSWORD }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('allows a logged-in POST to /admin/login without _csrf (login CSRF is covered by the Origin check)', async () => {
    const user = await newUser('login-exempt');
    const s = await session(user.email);
    const res = await post('/admin/login', s, { email: user.email, password: PASSWORD });
    expect(res.status).toBe(303);
    // The Origin check still applies.
    const cross = await post('/admin/login', s, { email: user.email, password: PASSWORD }, 'https://evil.example');
    expect(cross.status).toBe(403);
  });

  it('rejects a missing or wrong _csrf on a non-GET account route, for members and super admins', async () => {
    const member = await newUser('csrf-member');
    const admin = await newUser('csrf-super', true);
    const account = await newAccount('csrf-acct');
    await addMember(account.id, member.id);
    for (const who of [member, admin]) {
      const s = await session(who.email);
      const path = `/admin/accounts/${account.id}/anything`;
      expect((await post(path, s)).status).toBe(403);
      expect((await post(path, s, { _csrf: 'wrong' })).status).toBe(403);
    }
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
  it('guards every account route pattern with requireAccountAccess, and never reaches the handler for an intruder', async () => {
    const owner = await newUser('owner');
    const intruder = await newUser('intruder');
    const target = await newAccount('target');
    const own = await newAccount('own');
    await addMember(target.id, owner.id);
    await addMember(own.id, intruder.id);
    const s = await session(intruder.email);

    // The guard is registered directly on the wildcard, for all methods.
    const guard = adminRoutes.routes.find(
      (r) => r.method === 'ALL' && r.path === '/accounts/:accountId/*',
    );
    expect(guard?.handler).toBe(requireAccountAccess);

    // Every registered route under the prefix (ALL expanded over the usual methods), plus a path
    // that does not exist yet, so pages added later are covered.
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const patterns = new Set<string>(['GET /accounts/:accountId/__later', 'POST /accounts/:accountId/__later']);
    for (const r of adminRoutes.routes) {
      if (!/^\/accounts\/:accountId(\/|$)/.test(r.path)) continue;
      for (const m of r.method === 'ALL' ? METHODS : [r.method]) patterns.add(`${m} ${r.path}`);
    }
    expect(patterns.size).toBeGreaterThan(2);

    // A probe app with the same guard and a handler that answers 200, so a 404 proves it never ran.
    const probe = probeApp();
    probe.use('/accounts/:accountId/*', guard!.handler);
    for (const entry of patterns) {
      const [method, path] = entry.split(' ') as [string, string];
      probe.on(method, path, (c) => c.text('handler reached'));
    }

    const send = (method: string, path: string, accountId: string) =>
      probe.request(
        '/admin' + path.replace(':accountId', accountId).replace(/:\w+/g, 'x').replace('*', 'x'),
        {
          method,
          headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded' },
          body: method === 'GET' ? undefined : form({ _csrf: s.csrf }),
        },
      );
    const missingId = '00000000-0000-4000-8000-000000000000';
    for (const entry of patterns) {
      const [method, path] = entry.split(' ') as [string, string];
      const res = await send(method, path, target.id);
      expect(res.status, entry).toBe(404);
      const body = await res.text();
      expect(body, entry).not.toContain('handler reached');
      // Another account looks exactly like one that doesn't exist.
      const none = await send(method, path, missingId);
      expect(none.status, entry).toBe(404);
      expect(await none.text(), entry).toBe(body);
      // The member's own account does reach the handler.
      const mine = await send(method, path, own.id);
      expect(await mine.text(), entry).toBe('handler reached');
    }

    // And through the real app, the account home works for the member and not for the intruder.
    const home = (id: string) => app.request(`/admin/accounts/${id}`, { headers: s.headers });
    expect((await home(own.id)).status).toBe(200);
    expect((await home(target.id)).status).toBe(404);
    expect((await app.request('/admin/accounts/not-a-uuid', { headers: s.headers })).status).toBe(404);
  });

  it('redirects a trailing slash on an account page, and still 404s unknown paths', async () => {
    const user = await newUser('slash');
    const account = await newAccount('slash');
    await addMember(account.id, user.id);
    const s = await session(user.email);

    const res = await app.request(`/admin/accounts/${account.id}/`, { headers: s.headers });
    expect([301, 308]).toContain(res.status);
    const location = res.headers.get('location')!;
    expect(new URL(location, ORIGIN).pathname).toBe(`/admin/accounts/${account.id}`);
    const followed = await app.request(location, { headers: s.headers });
    expect(followed.status).toBe(200);

    const missing = await app.request(`/admin/accounts/${account.id}/nope/`, { headers: s.headers });
    expect([301, 308]).toContain(missing.status);
    const missingFollowed = await app.request(missing.headers.get('location')!, { headers: s.headers });
    expect(missingFollowed.status).toBe(404);
    expect(await missingFollowed.text()).toContain('Page not found');

    // /admin/ redirects to /admin, which renders.
    const root = await app.request('/admin/', { headers: s.headers });
    expect([301, 308]).toContain(root.status);
    expect(new URL(root.headers.get('location')!, ORIGIN).pathname).toBe('/admin');
    expect((await app.request('/admin', { headers: s.headers })).status).toBe(200);
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

  it('guards /manage/* with requireSuperAdmin: members get the same 404 as an unregistered page', async () => {
    const member = await newUser('manage-member');
    const admin = await newUser('manage-super', true);
    const m = await session(member.email);
    const a = await session(admin.email);

    const guard = adminRoutes.routes.find((r) => r.method === 'ALL' && r.path === '/manage/*');
    expect(guard?.handler).toBe(requireSuperAdmin);

    const probe = probeApp();
    probe.use('/manage/*', guard!.handler);
    probe.get('/manage/page', (c) => c.text('handler reached'));

    const refused = await probe.request('/admin/manage/page', { headers: m.headers });
    expect(refused.status).toBe(404);
    const unregistered = await app.request('/admin/zzz-unregistered', { headers: m.headers });
    expect(unregistered.status).toBe(404);
    const body = await refused.text();
    expect(body).not.toContain('handler reached');
    expect(body).toBe(await unregistered.text());

    const ok = await probe.request('/admin/manage/page', { headers: a.headers });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('handler reached');
    // Through the real app a member is also refused.
    expect((await app.request('/admin/manage/anything', { headers: m.headers })).status).toBe(404);
  });
});

/** A bare app that loads the session like the admin does, then runs whatever the test registers. */
function probeApp() {
  const probe = new Hono<AdminEnv>().basePath('/admin');
  probe.onError(adminOnError);
  probe.use('*', async (c, next) => {
    c.set('deps', { appDb, backend: new PostgresBackend(), config });
    const token = getCookie(c, SESSION_COOKIE);
    const user = token ? await loadSession(appDb, token) : undefined;
    if (!user) return c.text('no session', 401);
    c.set('user', user);
    await next();
  });
  return probe;
}

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

  describe('ensureSuperAdmin', () => {
    // Runs on a checked-out client in a transaction that demotes every super admin and rolls back,
    // so the cases don't depend on what other tests or the dev database hold.
    async function inEmptyTransaction(run: (client: pg.PoolClient) => Promise<void>) {
      const client = await appDb.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET is_super_admin = false WHERE is_super_admin');
        await run(client);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    const supers = async (db: pg.PoolClient) =>
      (await db.query('SELECT 1 FROM users WHERE is_super_admin')).rowCount ?? 0;

    it('creates the first super admin, who can log in, then does nothing more', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await inEmptyTransaction(async (db) => {
          expect(await ensureSuperAdmin(db, `seed-${tag}@example.test`, PASSWORD)).toBe(true);
          expect(await supers(db)).toBe(1);
          expect(await ensureSuperAdmin(db, `second-${tag}@example.test`, PASSWORD)).toBe(false);
          expect(await supers(db)).toBe(1);
          const { rows } = await db.query<{ is_super_admin: boolean }>(
            'SELECT is_super_admin FROM users WHERE email = $1',
            [`second-${tag}@example.test`],
          );
          expect(rows).toHaveLength(0);
        });
      } finally {
        log.mockRestore();
      }
    });

    it('warns and creates nothing when the variables are missing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await inEmptyTransaction(async (db) => {
          const before = (await db.query('SELECT 1 FROM users')).rowCount;
          expect(await ensureSuperAdmin(db, undefined, undefined)).toBe(false);
          expect(await ensureSuperAdmin(db, 'a@example.test', undefined)).toBe(false);
          expect(warn).toHaveBeenCalledTimes(2);
          expect((await db.query('SELECT 1 FROM users')).rowCount).toBe(before);
        });
      } finally {
        warn.mockRestore();
      }
    });

    it('propagates a UserError for a short password', async () => {
      await inEmptyTransaction(async (db) => {
        const error = await ensureSuperAdmin(db, `weak-${tag}@example.test`, 'short').catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(UserError);
        expect((error as UserError).code).toBe('weak_password');
        expect(await supers(db)).toBe(0);
      });
    });
  });
});

async function hashOf(userId: string): Promise<string> {
  const { rows } = await appDb.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]!.password_hash;
}

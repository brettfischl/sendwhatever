import { Hono, type Context, type ErrorHandler, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { trimTrailingSlash } from 'hono/trailing-slash';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError, isConnectionError, type AppEnv } from '../http/deps.js';
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  createSession,
  csrfToken,
  deleteSession,
  loadSession,
  validCsrf,
  type SessionUser,
} from './sessions.js';
import { connectPage } from './pages/connect.js';
import { createKey, credentialsPage, revealLogin, revokeKey } from './pages/credentials.js';
import { eventPayloadRoute, eventRoute } from './pages/events.js';
import { pipelineRoute } from './pages/pipeline.js';
import { schemaRoute } from './pages/schema.js';
import { trafficRoute } from './pages/traffic.js';
import { hashPassword, verifyPassword } from './users.js';
import { manageAccountRoutes } from './pages/manage-accounts.js';
import { manageUserRoutes } from './pages/manage-users.js';
import { AccountHomePage, AccountsPage, ErrorPage, LoginPage, type AccountSummary } from './views.js';

export interface AccountAccess extends AccountSummary {
  /** True for a super admin who is not a member: they can look but not change anything. */
  readOnly: boolean;
}

export type AdminEnv = {
  Bindings: AppEnv['Bindings'];
  Variables: AppEnv['Variables'] & {
    user?: SessionUser;
    sessionToken?: string;
    csrf?: string;
    account?: AccountAccess;
  };
};
type AdminContext = Context<AdminEnv>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOGIN_FAILED = 'Invalid email or password.';

// Checked against when the email is unknown, so a miss costs the same as a wrong password.
const DUMMY_HASH = await hashPassword('not a real password');

export const adminRoutes = new Hono<AdminEnv>();

export const adminOnError: ErrorHandler<AdminEnv> = (error, c) => {
  if (error instanceof HttpError) return page(c, error.status, error.message);
  if (error instanceof HTTPException) return page(c, error.status, 'Request refused');
  if (isConnectionError(error)) return page(c, 503, 'Database unavailable');
  console.error(error);
  return page(c, 500, 'Something went wrong');
};
adminRoutes.onError(adminOnError);
adminRoutes.notFound((c) => page(c, 404, 'Page not found'));

function page(c: AdminContext, status: ContentfulStatusCode, message: string) {
  c.header('cache-control', 'no-store');
  return c.html(<ErrorPage status={status} message={message} user={c.get('user')} />, status);
}

// First, so it sees the final 404 from the catch-all: redirects GET/HEAD for a missing path ending in '/'.
adminRoutes.use('*', trimTrailingSlash());

// Layer 1 of CSRF: reject cross-origin form posts, including the login form, which has no session.
adminRoutes.use('*', csrf());

// Admin pages show personal data, so nothing is cached.
adminRoutes.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

// Loads the session, if any, and enforces layer 2 of CSRF on every non-GET request that has one.
adminRoutes.use('*', async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const user = await loadSession(c.get('deps').appDb, token);
    if (user) {
      c.set('user', user);
      c.set('sessionToken', token);
      c.set('csrf', csrfToken(c.get('deps').config.encryptionKey, token));
    } else {
      deleteCookie(c, SESSION_COOKIE, { path: '/admin' });
    }
  }
  if (token && c.get('user') && !SAFE_METHODS.has(c.req.method) && c.req.path !== '/admin/login') {
    // Login is exempt: login CSRF is covered by the Origin check, and a logged-in POST without _csrf is allowed.
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    if (!validCsrf(c.get('deps').config.encryptionKey, token, body._csrf)) {
      throw new HttpError(403, 'Invalid or missing CSRF token');
    }
  }
  await next();
});

adminRoutes.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/admin');
  return c.html(<LoginPage />);
});

adminRoutes.post('/login', async (c) => {
  const { appDb } = c.get('deps');
  const body = await c.req.parseBody();
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const user = email
    ? (
        await appDb.query<{ id: string; password_hash: string; disabled_at: Date | null }>(
          'SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = lower($1)',
          [email],
        )
      ).rows[0]
    : undefined;
  const passwordOk = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !passwordOk || user.disabled_at) {
    return c.html(<LoginPage error={LOGIN_FAILED} />, 401);
  }

  // Replace any session this browser already had.
  const old = getCookie(c, SESSION_COOKIE);
  if (old) await deleteSession(appDb, old);
  const token = await createSession(appDb, user.id);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c));
  return c.redirect('/admin', 303);
});

/** The session cookie's attributes. `Secure` unless the request is to localhost. */
export function sessionCookieOptions(c: Context) {
  const host = new URL(c.req.url).hostname;
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/admin',
    secure: host !== 'localhost' && host !== '127.0.0.1',
    maxAge: SESSION_HOURS * 3600,
  };
}

// Everything below needs a login.
adminRoutes.use('*', async (c, next) => {
  if (!c.get('user')) return c.redirect('/admin/login', 303);
  await next();
});

adminRoutes.post('/logout', async (c) => {
  await deleteSession(c.get('deps').appDb, c.get('sessionToken')!);
  deleteCookie(c, SESSION_COOKIE, { path: '/admin' });
  return c.redirect('/admin/login', 303);
});

adminRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const { rows } = await c.get('deps').appDb.query<AccountSummary>(
    user.isSuperAdmin
      ? 'SELECT id, slug, status FROM accounts ORDER BY slug'
      : `SELECT a.id, a.slug, a.status FROM accounts a
           JOIN account_members m ON m.account_id = a.id
          WHERE m.user_id = $1 ORDER BY a.slug`,
    user.isSuperAdmin ? [] : [user.id],
  );
  return c.html(<AccountsPage user={user} csrf={c.get('csrf')!} accounts={rows} />);
});

/**
 * The one authorization check for account pages. Members get full access. A super admin can view
 * any account but only read. Anyone else gets 404, so an account's existence isn't revealed.
 */
export const requireAccountAccess: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const user = c.get('user')!;
  const accountId = c.req.param('accountId');
  if (!accountId || !UUID.test(accountId)) throw new HttpError(404, 'Page not found');

  const row = (
    await c.get('deps').appDb.query<AccountSummary & { is_member: boolean }>(
      `SELECT a.id, a.slug, a.status,
              EXISTS (SELECT 1 FROM account_members m
                       WHERE m.account_id = a.id AND m.user_id = $2) AS is_member
         FROM accounts a WHERE a.id = $1`,
      [accountId, user.id],
    )
  ).rows[0];
  if (!row || (!row.is_member && !user.isSuperAdmin)) throw new HttpError(404, 'Page not found');

  const readOnly = !row.is_member;
  if (readOnly && !SAFE_METHODS.has(c.req.method)) {
    throw new HttpError(403, 'Super admins have read-only access to accounts');
  }
  c.set('account', { id: row.id, slug: row.slug, status: row.status, readOnly });
  await next();
};

/** For pages under /admin/manage. Non-super-admins get 404, as if the pages did not exist. */
export const requireSuperAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  if (!c.get('user')?.isSuperAdmin) throw new HttpError(404, 'Page not found');
  await next();
};

adminRoutes.use('/accounts/:accountId/*', requireAccountAccess);
adminRoutes.use('/manage/*', requireSuperAdmin);

// Account pages go here, all under /accounts/:accountId. Later tickets add their routes next to this one.
adminRoutes.get('/accounts/:accountId', (c) => {
  const account = c.get('account')!;
  return c.html(
    <AccountHomePage
      user={c.get('user')!}
      csrf={c.get('csrf')!}
      account={account}
      readOnly={account.readOnly}
    />,
  );
});

adminRoutes.get('/accounts/:accountId/connect', connectPage);
adminRoutes.get('/accounts/:accountId/credentials', credentialsPage);
adminRoutes.post('/accounts/:accountId/credentials/keys', createKey);
adminRoutes.post('/accounts/:accountId/credentials/keys/:keyId/revoke', revokeKey);
adminRoutes.post('/accounts/:accountId/credentials/reveal', revealLogin);
adminRoutes.get('/accounts/:accountId/schema', schemaRoute);
adminRoutes.get('/accounts/:accountId/traffic', trafficRoute);
adminRoutes.get('/accounts/:accountId/pipeline', pipelineRoute);
adminRoutes.get('/accounts/:accountId/events/:eventId', eventRoute);
adminRoutes.post('/accounts/:accountId/events/:eventId/payload', eventPayloadRoute);
adminRoutes.route('/manage/accounts', manageAccountRoutes);
adminRoutes.route('/manage/users', manageUserRoutes);

// Keep this last: register new pages above it. Without it, an unknown /admin path would fall through to the main app's JSON 404.
adminRoutes.all('*', (c) => page(c, 404, 'Page not found'));

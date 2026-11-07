import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { hashApiKey } from '../secrets.js';
import { HttpError, type AppEnv } from './deps.js';

/** A key does one job: `ingest` only writes events and `read` only reads tables. */
export type ApiKeyScope = 'ingest' | 'read';

export interface Authenticated {
  accountId: string;
  slug: string;
}

/**
 * Resolves and authorizes the account for a public route. Throws an `HttpError`, which the app turns
 * into a JSON response. Checks run in this order: unknown slug (404), bad key (401), then account
 * status (403), so a wrong key never reveals whether an account is disabled.
 */
export async function authenticate(
  c: Context<AppEnv>,
  options: { allowQueryKey: boolean; scope?: ApiKeyScope },
): Promise<Authenticated> {
  const { appDb } = c.get('deps');

  // Caddy sets this in production from the subdomain.
  const slug = c.req.header('x-account-slug');
  const account = slug
    ? (
        await appDb.query<{ id: string; status: string }>(
          'SELECT id, status FROM accounts WHERE slug = $1',
          [slug],
        )
      ).rows[0]
    : undefined;
  if (!slug || !account) throw new HttpError(404, 'unknown account');

  const key = extractKey(c, options.allowQueryKey);
  const valid =
    key !== undefined &&
    (
      await appDb.query(
        `SELECT 1 FROM api_keys
          WHERE key_hash = $1 AND account_id = $2 AND scope = $3 AND revoked_at IS NULL`,
        [hashApiKey(key), account.id, options.scope ?? 'ingest'],
      )
    ).rowCount === 1;
  if (!valid) throw new HttpError(401, 'invalid or missing API key');

  // 'provisioning' has no usable store yet, so it is refused like a disabled account.
  if (account.status !== 'active') throw new HttpError(403, 'account is not active');

  return { accountId: account.id, slug };
}

function extractKey(c: Context<AppEnv>, allowQueryKey: boolean): string | undefined {
  const header = c.req.header('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (match) return match[1];
  if (allowQueryKey) return c.req.query('key') || undefined;
  return undefined;
}

/** Caddy adds X-Forwarded-For and X-Account-Slug to everything it proxies (§14.2). */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'via', 'x-account-slug'];

/** Hashing first gives equal lengths, which timingSafeEqual needs, and hides the token's length. */
function tokensMatch(given: string, expected: string): boolean {
  const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest();
  return timingSafeEqual(hash(given), hash(expected));
}

/** Whether a request carries a body. `c.env` is undefined under `app.request()` in tests. */
function hasBody(c: Context<AppEnv>): boolean {
  if (!c.env?.incoming) return c.req.raw.body !== null;
  return Number(c.req.header('content-length') ?? 0) > 0 || c.req.header('transfer-encoding') !== undefined;
}

/**
 * Guards every internal route (§13), in this order:
 *
 * 1. Caddy forwards only `/ingest` to this service (§14.2). If that routing is ever wrong, a request that
 *    came through a proxy gets a 404, so the public internet can't even learn these routes exist.
 * 2. A bearer token, which fails closed: with none configured, nothing can match. Customer API keys
 *    never get in.
 * 3. A body must be declared as JSON. A browser can send other types from any page with no preflight. A
 *    POST with no body, like `activate`, has nothing to declare.
 */
export const internalOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PROXY_HEADERS.some((header) => c.req.header(header) !== undefined)) {
    throw new HttpError(404, 'not found');
  }

  const token = c.get('deps').config.internalApiToken;
  const given = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1];
  if (!token || given === undefined || !tokensMatch(given, token)) {
    c.header('WWW-Authenticate', 'Bearer');
    throw new HttpError(401, 'invalid or missing internal token');
  }

  if (c.req.method === 'POST') {
    const type = c.req.header('content-type');
    if (type === undefined ? hasBody(c) : !/^application\/json\s*(;|$)/i.test(type)) {
      throw new HttpError(415, 'send application/json');
    }
  }
  await next();
};

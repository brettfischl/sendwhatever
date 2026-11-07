import type { Context } from 'hono';
import { hashApiKey } from '../secrets.js';
import { HttpError, type AppEnv } from './deps.js';

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
  options: { allowQueryKey: boolean },
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
        'SELECT 1 FROM api_keys WHERE key_hash = $1 AND account_id = $2 AND revoked_at IS NULL',
        [hashApiKey(key), account.id],
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

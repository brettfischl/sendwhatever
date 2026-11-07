import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export const SESSION_COOKIE = 'sw_admin';
export const SESSION_HOURS = 12;

type Queryable = Pick<pg.Pool, 'query'>;

export interface SessionUser {
  id: string;
  email: string;
  isSuperAdmin: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Starts a session. Returns the token for the cookie; only its hash is stored. */
export async function createSession(db: Queryable, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), userId, SESSION_HOURS],
  );
  return token;
}

/** The user for a live session, or undefined if it is unknown, expired, or the user is disabled. */
export async function loadSession(db: Queryable, token: string): Promise<SessionUser | undefined> {
  const { rows } = await db.query<{ id: string; email: string; is_super_admin: boolean }>(
    `SELECT u.id, u.email, u.is_super_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  return row && { id: row.id, email: row.email, isSuperAdmin: row.is_super_admin };
}

export async function deleteSession(db: Queryable, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** HMAC of the session token, keyed with the server's encryption key. */
export function csrfToken(key: Buffer, sessionToken: string): string {
  return createHmac('sha256', key).update(`csrf:${sessionToken}`).digest('base64url');
}

export function validCsrf(key: Buffer, sessionToken: string, submitted: unknown): boolean {
  if (typeof submitted !== 'string') return false;
  const expected = Buffer.from(csrfToken(key, sessionToken));
  const actual = Buffer.from(submitted);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

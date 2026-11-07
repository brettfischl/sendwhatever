import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type pg from 'pg';

export const MIN_PASSWORD_LENGTH = 12;

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

type Queryable = Pick<pg.Pool, 'query'>;

/** A bad input to a user helper, with a message that is safe to show an operator. */
export class UserError extends Error {}

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number) {
  const options: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r };
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Returns `scrypt$N$r$p$salt$hash` with base64 salt and hash, so the parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  let actual: Buffer;
  try {
    actual = await derive(password, Buffer.from(salt, 'base64'), +n, +r, +p, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

export interface NewUser {
  email: string;
  password: string;
  isSuperAdmin?: boolean;
}

/** Creates a user. The one place a new user's password is checked and hashed. */
export async function createUser(db: Queryable, input: NewUser): Promise<{ id: string }> {
  const email = input.email.trim();
  if (!email.includes('@')) throw new UserError('email is not valid');
  checkPassword(input.password);
  const hash = await hashPassword(input.password);
  try {
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, $3) RETURNING id',
      [email, hash, input.isSuperAdmin ?? false],
    );
    return { id: rows[0]!.id };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new UserError('email already in use');
    throw error;
  }
}

/** Sets a password and ends the user's sessions, so an old password's sessions don't outlive it. */
export async function setPassword(db: Queryable, userId: string, password: string): Promise<void> {
  checkPassword(password);
  const hash = await hashPassword(password);
  await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** Disables a user and deletes their sessions, so access ends immediately. */
export async function disableUser(db: Queryable, userId: string): Promise<void> {
  await db.query('UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1', [
    userId,
  ]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

/** Creates the first super admin if none exists. Does nothing otherwise. Returns whether it created one. */
export async function ensureSuperAdmin(
  db: Queryable,
  email: string | undefined,
  password: string | undefined,
): Promise<boolean> {
  const existing = await db.query('SELECT 1 FROM users WHERE is_super_admin LIMIT 1');
  if (existing.rowCount) return false;
  if (!email || !password) {
    console.warn('No super admin exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set; skipping.');
    return false;
  }
  try {
    await createUser(db, { email, password, isSuperAdmin: true });
  } catch (error) {
    // A concurrent start may have created the same user first.
    if (error instanceof UserError && error.message === 'email already in use') return false;
    throw error;
  }
  console.log(`Created the first super admin ${email}.`);
  return true;
}

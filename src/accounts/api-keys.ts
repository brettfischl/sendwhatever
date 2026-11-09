import type pg from 'pg';
import { generateApiKey, hashApiKey } from '../secrets.js';

type Queryable = Pick<pg.Pool, 'query'>;

/** A key does one job: `ingest` only writes events and `read` only reads tables. */
export type ApiKeyScope = 'ingest' | 'read';

/** Adds a key to an account and returns it. This is the only time it's readable: just the hash is stored. */
export async function createApiKey(
  db: Queryable,
  accountId: string,
  scope: ApiKeyScope = 'ingest',
): Promise<string> {
  const key = generateApiKey();
  await db.query('INSERT INTO api_keys (account_id, key_hash, scope) VALUES ($1, $2, $3)', [
    accountId,
    hashApiKey(key),
    scope,
  ]);
  return key;
}

/** The scope a key has when none is asked for. */
const DEFAULT_SCOPE: ApiKeyScope = 'ingest';

/** The account an unrevoked key of this scope belongs to, whatever its status, or undefined if there is none. */
export async function findActiveKeyOwner(
  db: Queryable,
  key: string,
  scope: ApiKeyScope = DEFAULT_SCOPE,
): Promise<{ id: string; slug: string; status: string } | undefined> {
  const { rows } = await db.query<{ id: string; slug: string; status: string }>(
    `SELECT a.id, a.slug, a.status
       FROM api_keys k JOIN accounts a ON a.id = k.account_id
      WHERE k.key_hash = $1 AND k.scope = $2 AND k.revoked_at IS NULL`,
    [hashApiKey(key), scope],
  );
  return rows[0];
}

/** Whether the key is the account's, unrevoked, and for this job. A read key never passes as an ingest key. */
export async function isActiveApiKey(
  db: Queryable,
  accountId: string,
  key: string,
  scope: ApiKeyScope = DEFAULT_SCOPE,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM api_keys
      WHERE key_hash = $1 AND account_id = $2 AND scope = $3 AND revoked_at IS NULL`,
    [hashApiKey(key), accountId, scope],
  );
  return rowCount === 1;
}

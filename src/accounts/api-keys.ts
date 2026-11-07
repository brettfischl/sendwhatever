import type pg from 'pg';
import { generateApiKey, hashApiKey } from '../secrets.js';

type Queryable = Pick<pg.Pool, 'query'>;

/** Adds a key to an account and returns it. This is the only time it's readable: just the hash is stored. */
export async function createApiKey(db: Queryable, accountId: string): Promise<string> {
  const key = generateApiKey();
  await db.query('INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2)', [
    accountId,
    hashApiKey(key),
  ]);
  return key;
}

export async function isActiveApiKey(db: Queryable, accountId: string, key: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM api_keys WHERE key_hash = $1 AND account_id = $2 AND revoked_at IS NULL',
    [hashApiKey(key), accountId],
  );
  return rowCount === 1;
}

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

/** Whether the key is the account's, unrevoked, and for this job. A read key never passes as an ingest key. */
export async function isActiveApiKey(
  db: Queryable,
  accountId: string,
  key: string,
  scope: ApiKeyScope = 'ingest',
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM api_keys
      WHERE key_hash = $1 AND account_id = $2 AND scope = $3 AND revoked_at IS NULL`,
    [hashApiKey(key), accountId, scope],
  );
  return rowCount === 1;
}

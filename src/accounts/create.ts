import type pg from 'pg';
import { StorageError, type StoreConfig } from '../contracts/index.js';
import { decryptJson, encryptJson, generateApiKey, hashApiKey } from '../secrets.js';
import type { AppDeps } from '../http/deps.js';

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FIRST_GENERATION = 1;

export type AccountErrorCode =
  | 'invalid_slug'
  | 'invalid_storage'
  | 'exists'
  | 'provision_unavailable'
  | 'provision_failed';

/** An expected failure of account creation. Callers map the code to their own response. */
export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Connection extends Record<string, unknown> {
  host: string;
  port: number;
  database: string;
}

interface Storage {
  connection: Connection;
  credentials: Record<string, unknown>;
}

interface StoreRow {
  id: string;
  namespace: string;
  connection: Connection;
  credentials: Buffer;
}

export interface CreatedAccount {
  accountId: string;
  slug: string;
  /** Shown once: only its hash is stored. */
  apiKey: string;
  database: { host: string; port: number; database: unknown; user: unknown; password: unknown };
}

export interface CreateAccountInput {
  /** Validated here, so callers can pass untrusted input. */
  slug: unknown;
  /** Undefined means the local data server. Validated here. */
  storage?: unknown;
}

/**
 * Creates an account: advisory lock, insert, provision, activate, first API key. Throws an
 * `AccountError` for expected failures. A retry after a failed provision resumes the same account.
 */
export async function createAccount(
  deps: Pick<AppDeps, 'appDb' | 'backend' | 'config'>,
  input: CreateAccountInput,
): Promise<CreatedAccount> {
  const slug = input.slug;
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new AccountError('invalid_slug', 'slug must be one lowercase DNS label');
  }
  const storage = parseStorage(input.storage);

  const client = await deps.appDb.connect();
  let broken = false;
  // The pool only listens to idle clients, and this one is held through a slow provision. Without this,
  // losing the connection would be an unhandled 'error' event that crashes the process. The next query
  // on it rejects instead.
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    // One session-level lock for the whole flow, so concurrent requests for a slug run one at a
    // time, and a retry never provisions while another call is mid-provision (that would rotate
    // the read-only password under it). Each step commits on its own, so a failed provision
    // leaves the account `provisioning` for a retry.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`sw_account:${slug}`]);
    try {
      return await run(deps, client, slug, storage);
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          `sw_account:${slug}`,
        ]);
      } catch {
        broken = true; // The session may still hold the lock, so don't return it to the pool.
      }
    }
  } catch (error) {
    // An AccountError is a normal outcome; anything else may leave the connection in a bad state.
    if (!(error instanceof AccountError)) broken = true;
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken ? true : undefined);
  }
}

async function run(
  deps: Pick<AppDeps, 'appDb' | 'backend' | 'config'>,
  client: pg.PoolClient,
  slug: string,
  storage: Storage | undefined,
): Promise<CreatedAccount> {
  const key = deps.config.encryptionKey;
  const existing = (
    await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM accounts WHERE slug = $1',
      [slug],
    )
  ).rows[0];

  let accountId: string;
  let store: StoreRow;
  if (existing) {
    // An active account's key was shown once and can't be shown again.
    if (existing.status !== 'provisioning') {
      throw new AccountError('exists', 'account already exists');
    }
    accountId = existing.id;
    const row = (
      await client.query<StoreRow>(
        `SELECT id, namespace, connection, credentials FROM account_stores
         WHERE account_id = $1 AND generation = $2`,
        [accountId, FIRST_GENERATION],
      )
    ).rows[0];
    if (!row) throw new Error(`account ${accountId} has no first store`);
    store = row;
  } else {
    const resolved = storage ?? defaultStorage(deps);
    await client.query('BEGIN');
    try {
      accountId = (
        await client.query<{ id: string }>('INSERT INTO accounts (slug) VALUES ($1) RETURNING id', [
          slug,
        ])
      ).rows[0]!.id;
      // 5 + 32 + 2 bytes, well inside Postgres's 63-byte identifier limit.
      const namespace = `acct_${accountId.replaceAll('-', '')}_${FIRST_GENERATION}`;
      const credentials = encryptJson(key, resolved.credentials);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO account_stores
           (account_id, generation, backend, connection, credentials, namespace, status)
         VALUES ($1, $2, 'postgres', $3, $4, $5, 'building') RETURNING id`,
        [accountId, FIRST_GENERATION, JSON.stringify(resolved.connection), credentials, namespace],
      );
      await client.query('COMMIT');
      store = {
        id: inserted.rows[0]!.id,
        namespace,
        connection: resolved.connection,
        credentials,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  const config: StoreConfig = {
    namespace: store.namespace,
    connection: store.connection,
    credentials: decryptJson(key, store.credentials),
  };
  let readOnly: Record<string, unknown>;
  try {
    readOnly = await deps.backend.provision(config);
  } catch (error) {
    if (error instanceof StorageError) {
      console.error('provision failed:', error.message);
      throw error.retryable
        ? new AccountError('provision_unavailable', 'storage is temporarily unavailable; retry')
        : new AccountError('provision_failed', 'storage provisioning failed');
    }
    throw error;
  }

  const apiKey = generateApiKey();
  await client.query('BEGIN');
  try {
    await client.query(
      `UPDATE account_stores SET read_credentials = $2, status = 'active' WHERE id = $1`,
      [store.id, encryptJson(key, readOnly)],
    );
    await client.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [accountId]);
    await client.query('INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2)', [
      accountId,
      hashApiKey(apiKey),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }

  return {
    accountId,
    slug,
    apiKey,
    database: {
      host: store.connection.host,
      port: store.connection.port,
      database: readOnly.database,
      user: readOnly.user,
      password: readOnly.password,
    },
  };
}

/** Undefined when omitted, which means the local data server. */
function parseStorage(value: unknown): Storage | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new AccountError('invalid_storage', 'storage must be an object');
  if (value.backend !== 'postgres') {
    throw new AccountError('invalid_storage', 'only the postgres backend is supported');
  }
  const { connection, credentials } = value;
  if (
    !isObject(connection) ||
    typeof connection.host !== 'string' ||
    typeof connection.port !== 'number' ||
    typeof connection.database !== 'string' ||
    !isObject(credentials) ||
    typeof credentials.user !== 'string' ||
    typeof credentials.password !== 'string'
  ) {
    throw new AccountError(
      'invalid_storage',
      'storage needs connection { host, port, database } and credentials { user, password }',
    );
  }
  return { connection: connection as Connection, credentials };
}

function defaultStorage(deps: Pick<AppDeps, 'config'>): Storage {
  return {
    connection: { host: 'localhost', port: deps.config.postgresPort, database: 'postgres' },
    credentials: { user: 'sw_data', password: deps.config.dataDbPassword },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

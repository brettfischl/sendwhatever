import { Hono, type Context } from 'hono';
import type pg from 'pg';
import { StorageError, type StoreConfig } from '../../contracts/index.js';
import { decryptJson, encryptJson, generateApiKey, hashApiKey } from '../../secrets.js';
import { HttpError, type AppDeps, type AppEnv } from '../deps.js';

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FIRST_GENERATION = 1;

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

export const accountRoutes = new Hono<AppEnv>();

/** Internal: no authentication. The server listens on loopback unless deliberately exposed. */
accountRoutes.post('/', async (c) => {
  const deps = c.get('deps');
  const body = await readJson(c.req.raw);
  const slug = body.slug;
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new HttpError(400, 'slug must be one lowercase DNS label');
  }
  const storage = parseStorage(body.storage);

  const client = await deps.appDb.connect();
  let broken = false;
  try {
    // One session-level lock for the whole flow, so concurrent requests for a slug run one at a
    // time, and a retry never provisions while another call is mid-provision (that would rotate
    // the read-only password under it). Each step commits on its own, so a failed provision
    // leaves the account `provisioning` for a retry.
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`sw_account:${slug}`]);
    try {
      return await createAccount(c, deps, client, slug, storage);
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
    // An HttpError is a normal outcome; anything else may leave the connection in a bad state.
    if (!(error instanceof HttpError)) broken = true;
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
});

async function createAccount(
  c: Context<AppEnv>,
  deps: AppDeps,
  client: pg.PoolClient,
  slug: string,
  storage: Storage | undefined,
) {
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
    if (existing.status !== 'provisioning') throw new HttpError(409, 'account already exists');
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
        ? new HttpError(503, 'storage is temporarily unavailable; retry')
        : new HttpError(500, 'storage provisioning failed');
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

  return c.json(
    {
      account_id: accountId,
      slug,
      api_key: apiKey,
      database: {
        host: store.connection.host,
        port: store.connection.port,
        database: readOnly.database,
        user: readOnly.user,
        password: readOnly.password,
      },
    },
    201,
  );
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  return body;
}

/** Undefined when omitted, which means the local data server. */
function parseStorage(value: unknown): Storage | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new HttpError(400, 'storage must be an object');
  if (value.backend !== 'postgres') {
    throw new HttpError(400, 'only the postgres backend is supported');
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
    throw new HttpError(
      400,
      'storage needs connection { host, port, database } and credentials { user, password }',
    );
  }
  return { connection: connection as Connection, credentials };
}

function defaultStorage(deps: AppDeps): Storage {
  return {
    connection: { host: 'localhost', port: deps.config.postgresPort, database: 'sw_data' },
    credentials: { user: 'sw_data', password: deps.config.dataDbPassword },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

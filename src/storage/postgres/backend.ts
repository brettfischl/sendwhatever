import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { StorageError } from '../../contracts/index.js';
import type {
  SchemaChange,
  StorageBackend,
  StoreConfig,
  TableRows,
} from '../../contracts/index.js';
import { toStorageError } from './errors.js';
import { mergeStatement, readOnlyRoleName, schemaChangeSql } from './sql.js';

const quote = pg.escapeIdentifier;

const CONNECT_TIMEOUT_MS = 10_000;

/**
 * `ALTER TABLE` queues behind a customer's long query, and every write then queues behind it. Giving
 * up quickly and retrying keeps ingestion moving.
 */
const DDL_LOCK_TIMEOUT = '5s';

/** So a blocked statement can't hold a pool slot forever. A cancelled statement is retried. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** An index build on a large table can take far longer than a write. */
const DDL_STATEMENT_TIMEOUT_MS = 600_000;
/** The client's limit catches a dead network, where the server's own timeout can't reach us. */
const CLIENT_TIMEOUT_MARGIN_MS = 5_000;

/** Limits for customer logins (§14.1). An idle open transaction would block DDL just like a query. */
const READ_ONLY_STATEMENT_TIMEOUT = '30s';
const READ_ONLY_IDLE_IN_TRANSACTION_TIMEOUT = '60s';

/** Concurrent grants on the database row fail with "tuple concurrently updated", even across stores. */
const PROVISION_LOCK = 'sendwhatever:provision';

function poolConfig(store: StoreConfig, statementTimeoutMs: number): pg.PoolConfig {
  const { host, port, database } = store.connection;
  const { user, password } = store.credentials ?? {};
  // pg falls back to PG* variables and localhost, which could silently reach the wrong server.
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof database !== 'string' ||
    typeof user !== 'string' ||
    typeof password !== 'string'
  ) {
    throw new StorageError(
      `Store ${store.namespace} needs connection host, port and database, and credentials user and password`,
      { retryable: false },
    );
  }
  return {
    host,
    port,
    database,
    user,
    password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
    keepAlive: true,
  };
}

export class PostgresBackend implements StorageBackend {
  readonly capabilities = { atomicWrites: true, idempotency: 'immediate' } as const;

  /** Stores on one server share a pool, since `write` runs for every event. */
  private readonly pools = new Map<string, pg.Pool>();
  private readonly statementTimeoutMs: number;

  constructor(options: { statementTimeoutMs?: number } = {}) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  }

  async provision(store: StoreConfig): Promise<Record<string, unknown>> {
    const user = readOnlyRoleName(store.namespace);
    // Postgres can't return an existing password, so a repeat call replaces it. A retry after a
    // crash therefore always returns credentials that work.
    const password = randomBytes(32).toString('hex');
    const schema = quote(store.namespace);
    const role = quote(user);

    try {
      await this.transaction(store, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT}'`);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          PROVISION_LOCK,
        ]);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

        const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
        if (existing.rowCount === 0) await client.query(`CREATE ROLE ${role}`);

        // These statements can't take bind parameters. The password is hex we generated above.
        await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${pg.escapeLiteral(password)}`);
        await client.query(
          `ALTER ROLE ${role} SET statement_timeout = '${READ_ONLY_STATEMENT_TIMEOUT}'`,
        );
        await client.query(
          `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${READ_ONLY_IDLE_IN_TRANSACTION_TIMEOUT}'`,
        );
        await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
        await client.query(`ALTER ROLE ${role} SET search_path = ${schema}`);

        const database = await client.query<{ name: string }>(
          'SELECT current_database() AS name',
        );
        const databaseName = quote(database.rows[0]?.name ?? '');
        await client.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${role}`);
        await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
        // Table-level SELECT also covers columns added later.
        await client.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`,
        );
      });
    } catch (error) {
      throw toStorageError('provision', error, { ddl: true });
    }
    return { user, password };
  }

  async applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void> {
    if (changes.length === 0) return;
    try {
      const statements = changes.map((change) => schemaChangeSql(store.namespace, change));
      // One transaction each, so `ALTER TABLE`'s exclusive lock isn't held through an index build.
      // Every change is idempotent, so a retry after a partial failure finishes the rest (§9).
      for (const text of statements) {
        // pg honours a per-query `query_timeout`, though its types only declare it on the pool.
        const query = { text, query_timeout: DDL_STATEMENT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS };
        await this.transaction(store, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT}'`);
          await client.query(`SET LOCAL statement_timeout = ${DDL_STATEMENT_TIMEOUT_MS}`);
          await client.query(query);
        });
      }
    } catch (error) {
      throw toStorageError('applySchema', error, { ddl: true });
    }
  }

  async write(store: StoreConfig, tables: TableRows[]): Promise<void> {
    if (tables.every(({ rows }) => rows.length === 0)) return;
    try {
      await this.transaction(store, async (client) => {
        // One statement per row, since rows can include different columns and may repeat an id.
        for (const { table, columns, rows } of tables) {
          for (const row of rows) {
            await client.query(mergeStatement(store.namespace, table, columns, row));
          }
        }
      });
    } catch (error) {
      throw toStorageError('write', error);
    }
  }

  async health(store: StoreConfig): Promise<void> {
    try {
      const result = await this.pool(store).query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [
        store.namespace,
      ]);
      if (result.rowCount === 0) {
        throw new StorageError(`Schema for store ${store.namespace} does not exist`, {
          retryable: false,
        });
      }
    } catch (error) {
      throw toStorageError('health', error);
    }
  }

  /** Closes every pool. Call it on shutdown, because open pools keep the process alive. */
  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((pool) => pool.end()));
  }

  private pool(store: StoreConfig): pg.Pool {
    const config = poolConfig(store, this.statementTimeoutMs);
    const key = JSON.stringify([
      config.host,
      config.port,
      config.database,
      config.user,
      config.password,
    ]);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new pg.Pool(config);
      // Without a listener, a dropped idle connection would crash the process. The next query that
      // needs a connection reports the failure if it persists.
      pool.on('error', () => {});
      this.pools.set(key, pool);
    }
    return pool;
  }

  private async transaction(
    store: StoreConfig,
    run: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool(store).connect();
    let broken: Error | undefined;
    // The pool only listens to idle clients. Without this, losing the connection here would be an
    // unhandled 'error' event that crashes the process. The running query also rejects with it.
    const onError = (error: Error) => {
      broken = error;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      await run(client);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // Destroy the connection rather than return one with an open transaction to the pool.
        broken = rollbackError as Error;
      }
      throw error;
    } finally {
      client.removeListener('error', onError);
      client.release(broken);
    }
  }
}

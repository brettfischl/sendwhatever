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

/**
 * A connection serves one database, so every store has its own pool and they all share the server's
 * `max_connections`. Pools stay small, and idle connections close quickly so that quiet stores hold
 * none.
 */
const POOL_MAX_CONNECTIONS = 5;
const POOL_IDLE_TIMEOUT_MS = 10_000;

/** Limits for customer logins (§14.1). An idle open transaction would block DDL just like a query. */
const READ_ONLY_STATEMENT_TIMEOUT = '30s';
const READ_ONLY_IDLE_IN_TRANSACTION_TIMEOUT = '60s';
/** So one customer can't use up the server's `max_connections`. */
const READ_ONLY_CONNECTION_LIMIT = 10;

export interface PostgresBackendOptions {
  statementTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class PostgresBackend implements StorageBackend {
  readonly capabilities = { atomicWrites: true, idempotency: 'immediate' } as const;

  private readonly pools = new Map<string, pg.Pool>();
  private readonly statementTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: PostgresBackendOptions = {}) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? POOL_IDLE_TIMEOUT_MS;
  }

  /**
   * Creates the store's database, named after its namespace, and a login that can reach only that
   * database. `connection.database` names the existing database to run this from. Tables live in the
   * new database's `public` schema.
   */
  async provision(store: StoreConfig): Promise<Record<string, unknown>> {
    const user = readOnlyRoleName(store.namespace);
    // Postgres can't return an existing password, so a repeat call replaces it. A retry after a
    // crash therefore always returns credentials that work.
    const password = randomBytes(32).toString('hex');
    const database = quote(store.namespace);
    const role = quote(user);

    try {
      await this.createDatabaseAndLogin(store, async (client) => {
        const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          store.namespace,
        ]);
        // Can't run in a transaction. template0 can't have connections that would block the copy.
        if (existing.rowCount === 0) {
          await client.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
        }
        // New databases allow CONNECT and TEMP to PUBLIC, which would admit every store's login.
        await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);

        await client.query('BEGIN');
        const login = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
        if (login.rowCount === 0) await client.query(`CREATE ROLE ${role}`);
        // These statements can't take bind parameters. The password is hex we generated above.
        await client.query(
          `ALTER ROLE ${role} LOGIN CONNECTION LIMIT ${READ_ONLY_CONNECTION_LIMIT}
           PASSWORD ${pg.escapeLiteral(password)}`,
        );
        await client.query(
          `ALTER ROLE ${role} SET statement_timeout = '${READ_ONLY_STATEMENT_TIMEOUT}'`,
        );
        await client.query(
          `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${READ_ONLY_IDLE_IN_TRANSACTION_TIMEOUT}'`,
        );
        await client.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
        await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
        await client.query('COMMIT');

        // Still under the lock, or overlapping GRANTs fail with `tuple concurrently updated`.
        await this.transaction(store, async (storeClient) => {
          await storeClient.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
          await storeClient.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
          // Table-level SELECT also covers columns added later.
          await storeClient.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`,
          );
        });
      });
    } catch (error) {
      throw toStorageError('provision', error, { ddl: true });
    }
    return { user, password, database: store.namespace };
  }

  async applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void> {
    if (changes.length === 0) return;
    try {
      const statements = changes.map(schemaChangeSql);
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
            await client.query(mergeStatement(table, columns, row));
          }
        }
      });
    } catch (error) {
      throw toStorageError('write', error);
    }
  }

  /** Connecting to the store's database is the check: a missing one fails permanently. */
  async health(store: StoreConfig): Promise<void> {
    try {
      await this.pool(store).query('SELECT 1');
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

  private config(store: StoreConfig, database: unknown): pg.ClientConfig {
    const { host, port } = store.connection;
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
      statement_timeout: this.statementTimeoutMs,
      query_timeout: this.statementTimeoutMs + CLIENT_TIMEOUT_MARGIN_MS,
      keepAlive: true,
    };
  }

  private pool(store: StoreConfig): pg.Pool {
    const config = this.config(store, store.namespace);
    const key = JSON.stringify([
      config.host,
      config.port,
      config.database,
      config.user,
      config.password,
    ]);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new pg.Pool({
        ...config,
        max: POOL_MAX_CONNECTIONS,
        idleTimeoutMillis: this.idleTimeoutMs,
      });
      // Without a listener, a dropped idle connection would crash the process. The next query that
      // needs a connection reports the failure if it persists.
      pool.on('error', () => {});
      this.pools.set(key, pool);
    }
    return pool;
  }

  /**
   * Runs on its own connection to `connection.database`, which customer logins can't reach, so they
   * can't take this lock. It's held until `run` finishes. Ending the connection releases the lock and
   * rolls back anything unfinished.
   */
  private async createDatabaseAndLogin(
    store: StoreConfig,
    run: (client: pg.Client) => Promise<void>,
  ): Promise<void> {
    const client = new pg.Client(this.config(store, store.connection.database));
    // The running query rejects with the same failure, so there's nothing more to do here.
    client.on('error', () => {});
    await client.connect();
    try {
      // Overlapping calls for one store would otherwise race to create the same database and role.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [store.namespace]);
      await run(client);
    } finally {
      await client.end();
    }
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

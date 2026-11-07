// The schema registry (PRD §9): compares a plan against `data_columns`, and applies what is missing.
import type pg from 'pg';
import {
  StorageError,
  type LogicalType,
  type SchemaChange,
  type StorageBackend,
  type StoreConfig,
  type TableRow,
  type TableRows,
} from '../contracts/index.js';
import type { WritePlan } from './plan.js';

/**
 * `create_table` includes `id`, and registering it records that the table exists, even if it has no
 * other columns. An index is applied with its column, so a registered column has its index.
 */
const TABLE_MARKER_COLUMN = 'id';

const PLATFORM_COLUMNS = new Set(['id', '_event_seq', '_deleted_at']);

/**
 * How long a worker waits for a store's schema lock. Each waiter holds a pooled connection, so
 * without a limit a hung backend could use up the pool and stall other stores too.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export type RegisteredColumns = Map<string, Map<string, LogicalType>>;

export interface SchemaTarget {
  /** `account_stores.id`. */
  storeId: string;
  store: StoreConfig;
}

/**
 * `tables` is ready for `StorageBackend.write`.
 *
 * Other failures are thrown, and a worker treats them as retryable: a `StorageError` with
 * `retryable: true`, or an error from the application database, including a lock timeout.
 */
export type SchemaResult =
  | { ok: true; tables: TableRows[] }
  | { ok: false; reason: 'schema_conflict' | 'write_error'; detail: string };

/** A non-null value whose type differs from the registered one is a conflict, listed per column. */
export function findConflicts(tables: TableRows[], registered: RegisteredColumns): string[] {
  const conflicts: string[] = [];
  for (const { table, columns } of tables) {
    for (const [column, type] of Object.entries(columns)) {
      const existing = registered.get(table)?.get(column);
      if (existing && existing !== type) {
        conflicts.push(`${table}.${column} is registered as ${existing}, but this event has ${type}`);
      }
    }
  }
  return conflicts;
}

/** Reduces a plan's changes to the ones the registry doesn't record. */
export function findMissingChanges(
  changes: SchemaChange[],
  registered: RegisteredColumns,
): SchemaChange[] {
  return changes.filter((change) => {
    const column = change.kind === 'create_table' ? TABLE_MARKER_COLUMN : change.column;
    return !registered.get(change.table)?.has(column);
  });
}

/**
 * Makes every row key a real column listed in `columns`. A `null` for a registered column clears it,
 * so it stays, with the registered type. A `null` for an unknown column creates nothing, so it goes:
 * the backend would otherwise be asked to write a column that doesn't exist.
 */
export function resolveNullColumns(tables: TableRows[], registered: RegisteredColumns): TableRows[] {
  return tables.map(({ table, columns, rows }) => {
    const resolved = new Map(Object.entries(columns));
    const known = registered.get(table);
    const resolvedRows = rows.map((row) => {
      const kept: TableRow = { id: row.id, _event_seq: row._event_seq };
      for (const [key, value] of Object.entries(row)) {
        if (PLATFORM_COLUMNS.has(key)) {
          kept[key] = value;
          continue;
        }
        const type = resolved.get(key) ?? known?.get(key);
        if (!type) continue;
        resolved.set(key, type);
        kept[key] = value;
      }
      return kept;
    });
    return { table, columns: Object.fromEntries(resolved), rows: resolvedRows };
  });
}

/** Text hashed into the advisory lock key, which serializes schema changes per store. */
export function schemaLockName(storeId: string): string {
  return `data_columns:${storeId}`;
}

async function readRegistry(
  db: Pick<pg.ClientBase, 'query'>,
  storeId: string,
  tables: string[],
): Promise<RegisteredColumns> {
  const result = await db.query<{ table_name: string; column_name: string; logical_type: LogicalType }>(
    `SELECT table_name, column_name, logical_type FROM data_columns
     WHERE store_id = $1 AND table_name = ANY($2::text[])`,
    [storeId, tables],
  );
  const registered: RegisteredColumns = new Map();
  for (const { table_name: table, column_name: column, logical_type: type } of result.rows) {
    let columns = registered.get(table);
    if (!columns) {
      columns = new Map();
      registered.set(table, columns);
    }
    columns.set(column, type);
  }
  return registered;
}

async function recordChanges(
  db: Pick<pg.ClientBase, 'query'>,
  storeId: string,
  changes: SchemaChange[],
): Promise<void> {
  const entries = changes.flatMap((change): [string, string, LogicalType][] => {
    if (change.kind === 'create_table') return [[change.table, TABLE_MARKER_COLUMN, 'string']];
    if (change.kind === 'add_column') return [[change.table, change.column, change.type]];
    return [];
  });
  await db.query(
    `INSERT INTO data_columns (store_id, table_name, column_name, logical_type)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[])
     ON CONFLICT (store_id, table_name, column_name) DO NOTHING`,
    [
      storeId,
      entries.map((entry) => entry[0]),
      entries.map((entry) => entry[1]),
      entries.map((entry) => entry[2]),
    ],
  );
}

function schemaConflict(conflicts: string[]): SchemaResult {
  return { ok: false, reason: 'schema_conflict', detail: conflicts.join('; ') };
}

/**
 * Brings a store's schema up to what a plan needs, and returns rows ready to write. On a conflict
 * nothing is changed on the store, so nothing from the event reaches it.
 *
 * The lock is held in a transaction, so it is released even if the worker dies. The backend change
 * comes first and the registry second, so after a crash between them the column is still missing
 * from the registry, and the next event reapplies the idempotent change.
 */
export async function applyPlanSchema(
  pool: pg.Pool,
  backend: Pick<StorageBackend, 'applySchema'>,
  { storeId, store }: SchemaTarget,
  plan: WritePlan,
  { lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS }: { lockTimeoutMs?: number } = {},
): Promise<SchemaResult> {
  const tableNames = plan.tables.map(({ table }) => table);

  let registered = await readRegistry(pool, storeId, tableNames);
  let conflicts = findConflicts(plan.tables, registered);
  if (conflicts.length > 0) return schemaConflict(conflicts);

  if (findMissingChanges(plan.changes, registered).length > 0) {
    const client = await pool.connect();
    let brokenConnection: Error | undefined;
    try {
      await client.query('BEGIN');
      // Like SET LOCAL, but it can take a bound value. It ends with the transaction.
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${lockTimeoutMs}ms`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        schemaLockName(storeId),
      ]);
      // Another worker may have registered these while this one waited, possibly with other types.
      registered = await readRegistry(client, storeId, tableNames);
      conflicts = findConflicts(plan.tables, registered);
      const missing = findMissingChanges(plan.changes, registered);
      if (conflicts.length === 0 && missing.length > 0) {
        await backend.applySchema(store, missing);
        await recordChanges(client, storeId, missing);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch((rollbackError: Error) => {
        brokenConnection = rollbackError;
      });
      if (error instanceof StorageError && !error.retryable) {
        return { ok: false, reason: 'write_error', detail: error.message };
      }
      throw error;
    } finally {
      client.release(brokenConnection);
    }
    if (conflicts.length > 0) return schemaConflict(conflicts);
  }

  return { ok: true, tables: resolveNullColumns(plan.tables, registered) };
}

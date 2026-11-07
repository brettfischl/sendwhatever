import pg from 'pg';
import { decryptJson } from '../secrets.js';

/** Reads rows for the public table API. Tables and columns come only from the account's registry. */

export const DEFAULT_ROW_LIMIT = 100;
export const MAX_ROW_LIMIT = 1000;

const CONNECT_TIMEOUT_MS = 3000;
const STATEMENT_TIMEOUT_MS = 5000;

export interface ReadableStore {
  id: string;
  connection: Record<string, unknown>;
  readCredentials: Buffer | null;
}

export async function getReadableStore(
  db: pg.Pool,
  accountId: string,
): Promise<ReadableStore | undefined> {
  const { rows } = await db.query<{
    id: string;
    connection: Record<string, unknown>;
    read_credentials: Buffer | null;
  }>(
    `SELECT id, connection, read_credentials FROM account_stores
      WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  const row = rows[0];
  return row && { id: row.id, connection: row.connection, readCredentials: row.read_credentials };
}

export type TableColumns = Map<string, string>;

/** The table's columns and logical types, `id` included, or undefined if the store has no such table. */
export async function getTableColumns(
  db: pg.Pool,
  storeId: string,
  table: string,
): Promise<TableColumns | undefined> {
  const { rows } = await db.query<{ column_name: string; logical_type: string }>(
    `SELECT column_name, logical_type FROM data_columns
      WHERE store_id = $1 AND table_name = $2 ORDER BY column_name`,
    [storeId, table],
  );
  if (rows.length === 0) return undefined;
  // Platform columns are bookkeeping, and client columns can't start with an underscore.
  return new Map(
    rows
      .filter((r) => !r.column_name.startsWith('_'))
      .map((r) => [r.column_name, r.logical_type]),
  );
}

/** Query parameters the API itself uses, so a column with one of these names can't be filtered on. */
export const RESERVED_PARAMS = new Set(['limit', 'after']);

/** Whether `?column=value` can filter on this column. A `json` value has no single text form. */
export function isFilterable(column: string, type: string): boolean {
  return type !== 'json' && !RESERVED_PARAMS.has(column);
}

/**
 * The value to compare a column with, or undefined if it can't be that column's type. Checking here
 * means a bad value is the client's 400, not a failed cast in the database.
 */
export function parseFilterValue(type: string, value: string): string | undefined {
  if (value.includes('\0')) return undefined;
  switch (type) {
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value)) ? value : undefined;
    case 'boolean':
      return value === 'true' || value === 'false' ? value : undefined;
    case 'timestamp':
      return Number.isNaN(Date.parse(value)) ? undefined : value;
    default:
      return value;
  }
}

export interface RowQuery {
  table: string;
  columns: string[];
  limit: number;
  /** Returns rows after this id. */
  after?: string;
  /** Returns only the row with this id. */
  id?: string;
  /** Column and already checked value pairs that a row must equal. Names come from the registry. */
  filters?: [column: string, value: string][];
}

/**
 * Live rows ordered by `id`, read with the store's read-only login. `row_to_json` writes timestamps
 * as ISO 8601 with their full precision, and numbers and JSON columns as JSON.
 */
export async function readRows(
  store: ReadableStore,
  key: Buffer,
  { table, columns, limit, after, id, filters = [] }: RowQuery,
): Promise<Record<string, unknown>[]> {
  const { host, port } = store.connection;
  if (!store.readCredentials || typeof host !== 'string' || typeof port !== 'number') {
    throw new Error('store has no usable read-only login');
  }
  const { user, password, database } = decryptJson(key, store.readCredentials);
  const client = new pg.Client({
    host,
    port,
    database: database as string,
    user: user as string,
    password: password as string,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 2000,
  });
  // An error between queries would otherwise crash the process.
  client.on('error', () => undefined);
  try {
    await client.connect();
    const values: unknown[] = [limit];
    let where = '"_deleted_at" IS NULL';
    if (after !== undefined) {
      values.push(after);
      where += ` AND "id" > $${values.length}`;
    }
    if (id !== undefined) {
      values.push(id);
      where += ` AND "id" = $${values.length}`;
    }
    for (const [column, value] of filters) {
      values.push(value);
      where += ` AND ${pg.escapeIdentifier(column)} = $${values.length}`;
    }
    const names = columns.map(pg.escapeIdentifier).join(', ');
    const { rows } = await client.query<{ row: Record<string, unknown> }>(
      `SELECT row_to_json(t) AS row FROM (
         SELECT ${names} FROM "public".${pg.escapeIdentifier(table)}
          WHERE ${where} ORDER BY "id" LIMIT $1
       ) t ORDER BY t."id"`,
      values,
    );
    return rows.map((r) => r.row);
  } finally {
    await client.end().catch(() => undefined);
  }
}

import { createHash } from 'node:crypto';
import pg from 'pg';
import { StorageError } from '../../contracts/index.js';
import type { LogicalType, SchemaChange, TableRow } from '../../contracts/index.js';

const quote = pg.escapeIdentifier;

const MAX_IDENTIFIER_BYTES = 63;

/** Row keys that are bound explicitly rather than treated as data columns. */
const PLATFORM_KEYS = new Set(['id', '_event_seq', '_deleted_at']);

/** Target alias in the merge, so a table named `excluded` can't be ambiguous. */
const TARGET = quote('_row');

const SQL_TYPES = new Map<LogicalType, string>([
  ['string', 'TEXT'],
  ['number', 'NUMERIC'],
  ['boolean', 'BOOLEAN'],
  ['timestamp', 'TIMESTAMPTZ'],
  ['json', 'JSONB'],
]);

function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

/**
 * Names a primary key or index. Tables and indexes share one namespace in a schema, so a bare
 * `CREATE TABLE IF NOT EXISTS "a_pkey"` would silently do nothing if an index had that name. Client
 * identifiers can't start with an underscore (§9), so this prefix can't collide with a table. The
 * hash keeps `a_b` + `c` and `a` + `b_c` apart, and the length stays under the 63-byte limit.
 */
function relationName(kind: 'pk' | 'ix', ...parts: string[]): string {
  return `_${kind}_${parts.join('_').slice(0, 40)}_${shortHash(...parts)}`;
}

/** The login for a store. Role names are global to the server, so it's derived from the namespace. */
export function readOnlyRoleName(namespace: string): string {
  const name = `${namespace}_ro`;
  if (Buffer.byteLength(name) <= MAX_IDENTIFIER_BYTES) return name;
  return `${namespace.slice(0, 40)}_${shortHash(namespace)}_ro`;
}

/** Each store has its own database, and its tables live in that database's `public` schema. */
function qualified(table: string): string {
  return `"public".${quote(table)}`;
}

/** Every statement is additive and idempotent, and no other DDL exists here (§9). */
export function schemaChangeSql(change: SchemaChange): string {
  const target = qualified(change.table);
  switch (change.kind) {
    case 'create_table': {
      const primaryKey = quote(relationName('pk', change.table));
      return `CREATE TABLE IF NOT EXISTS ${target} (
        "id" TEXT CONSTRAINT ${primaryKey} PRIMARY KEY,
        "_event_seq" BIGINT NOT NULL,
        "_deleted_at" TIMESTAMPTZ
      )`;
    }
    case 'add_column': {
      const sqlType = SQL_TYPES.get(change.type);
      if (!sqlType) {
        throw new StorageError(`Unknown logical type: ${String(change.type)}`, { retryable: false });
      }
      return `ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS ${quote(change.column)} ${sqlType}`;
    }
    case 'add_index': {
      const index = quote(relationName('ix', change.table, change.column));
      return `CREATE INDEX IF NOT EXISTS ${index} ON ${target} (${quote(change.column)})`;
    }
    default:
      throw new StorageError(`Unknown schema change: ${JSON.stringify(change)}`, {
        retryable: false,
      });
  }
}

/** pg would send a JS array as a Postgres array and a string as bare text, neither valid JSONB. */
function bindValue(type: LogicalType, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return type === 'json' ? JSON.stringify(value) : value;
}

/**
 * Merges one row under the §11.2 MVP option. A write at or above the row's `_event_seq` replaces
 * the included columns and `_deleted_at`, which clears if the row leaves it out. A lower write only
 * fills `NULL` data columns and never touches `_deleted_at`. The comparison happens in SQL because
 * `_event_seq` is decimal text.
 */
export function mergeStatement(
  table: string,
  columns: Record<string, LogicalType>,
  row: TableRow,
): { text: string; values: unknown[] } {
  const dataColumns = Object.keys(row).filter((key) => !PLATFORM_KEYS.has(key));
  const values: unknown[] = [row.id, row._event_seq, row._deleted_at ?? null];

  for (const column of dataColumns) {
    // hasOwn, since `constructor` is a valid column name that a plain lookup would find.
    const type = Object.hasOwn(columns, column) ? columns[column] : undefined;
    if (!type) {
      throw new StorageError(`Row in ${table} has undeclared column ${column}`, {
        retryable: false,
      });
    }
    values.push(bindValue(type, row[column]));
  }

  const names = ['id', '_event_seq', '_deleted_at', ...dataColumns].map(quote);
  const placeholders = names.map((_, index) => `$${index + 1}`);
  const isCurrent = `EXCLUDED."_event_seq" >= ${TARGET}."_event_seq"`;
  const assignments = dataColumns.map((column) => {
    const name = quote(column);
    return `${name} = CASE WHEN ${isCurrent} THEN EXCLUDED.${name}
      ELSE COALESCE(${TARGET}.${name}, EXCLUDED.${name}) END`;
  });

  const text = `INSERT INTO ${qualified(table)} AS ${TARGET} (${names.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT ("id") DO UPDATE SET
      ${[
        ...assignments,
        `"_deleted_at" = CASE WHEN ${isCurrent} THEN EXCLUDED."_deleted_at"
          ELSE ${TARGET}."_deleted_at" END`,
        `"_event_seq" = GREATEST(${TARGET}."_event_seq", EXCLUDED."_event_seq")`,
      ].join(',\n      ')}`;

  return { text, values };
}

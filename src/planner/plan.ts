// The pure half of write planning (PRD §8, §9): adapter output in, schema changes and rows out. It
// reads no clock, randomness, or database, so replaying an event produces the same plan.
//
// The input comes from untrusted adapter code. TypeScript's view of it is a claim, not a fact, so
// everything is checked here as `unknown`, and bad output fails as a result rather than throwing.
import type {
  AdapterResult,
  LogicalType,
  SchemaChange,
  TableRow,
  TableRows,
} from '../contracts/index.js';
import { OpaquePathError, parseOpaquePath } from '../fingerprint/index.js';
import { uuid5 } from './uuid5.js';

export interface PlanContext {
  /** `events.id`. */
  eventId: string;
  /** `events.seq` as decimal text. */
  eventSeq: string;
  /** `events.received_at` as an ISO 8601 string. It becomes `_deleted_at`, so replays match. */
  receivedAt: string;
  /** The `opaque_paths` of the adapter that produced this output (§7.1). */
  opaquePaths: readonly string[];
}

export interface WritePlan {
  /**
   * Everything these rows need to exist, ignoring what already does. The registry reduces this to
   * what is missing.
   */
  changes: SchemaChange[];
  /**
   * One entry per table, with at most one row per `id`. `columns` lists only columns with a non-null
   * value here, so a row can hold a `null` for a column not in `columns`. The registry resolves
   * those, and only its output is ready for `StorageBackend.write`.
   */
  tables: TableRows[];
}

export type PlanFailureReason = 'adapter_error' | 'schema_conflict';

export type PlanResult =
  | { ok: true; plan: WritePlan }
  | { ok: false; reason: PlanFailureReason; detail: string };

/** The keys on a row that aren't columns. */
const ROW_KEYS = new Set(['id', '_deleted', 'children']);
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
/** Postgres refuses these as column names (§9). Rejecting them here lets the gate catch it. */
const SYSTEM_COLUMNS = new Set(['xmin', 'xmax', 'cmin', 'cmax', 'ctid', 'tableoid']);
const MAX_IDENTIFIER_LENGTH = 63;

/** A `timestamp` value: ISO 8601 with a required timezone. Calendar limits are checked separately. */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/;

class PlanFailure extends Error {
  constructor(
    readonly reason: PlanFailureReason,
    detail: string,
  ) {
    super(detail);
  }
}

function adapterError(detail: string): PlanFailure {
  return new PlanFailure('adapter_error', detail);
}

/** Identifiers in a failure detail are untrusted and possibly huge. */
function quote(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name);
}

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name)) {
    throw adapterError(`${what} ${quote(name)} must match ${IDENTIFIER.source}`);
  }
  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw adapterError(`${what} ${quote(name)} is longer than ${MAX_IDENTIFIER_LENGTH} characters`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Rejects arrays, and also Date and Map, which would serialize as something other than themselves.
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isValidTimestamp(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0)) as [number, number, number, number, number, number, number, number];
  // Date rolls an impossible date like Feb 30 into March, so it only round-trips if the date is real.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    year > 0 &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 15 &&
    offsetMinute <= 59
  );
}

interface TableDraft {
  columns: Map<string, LogicalType>;
  indexed: Set<string>;
  /** Insertion-ordered, so the output is deterministic. */
  rows: Map<string, TableRow>;
}

interface ParentRow {
  table: string;
  id: string;
  /** The adapter supplied the id, or it derives from a stable parent and a position (§8). */
  idIsStable: boolean;
}

/** Where an object sits in the output. */
interface Location {
  /** Unique within an event, so it can identify a row. */
  path: (string | number)[];
  /** The `children` keys leading here, for matching opaque paths. */
  keys: string[];
}

class Planner {
  readonly drafts = new Map<string, TableDraft>();
  private readonly opaquePaths: string[][];

  constructor(private readonly context: PlanContext) {
    // Opaque paths are payload paths, like `orders[].metadata`. Output paths have no array segments.
    this.opaquePaths = context.opaquePaths.map((path) =>
      parseOpaquePath(path).filter((segment) => segment !== '[]'),
    );
  }

  planObject(object: unknown, tableName: unknown, location: Location, parent?: ParentRow): void {
    if (!isRecord(object)) throw adapterError(`Expected an object at ${JSON.stringify(location.path)}`);
    if (typeof tableName !== 'string') {
      throw adapterError(`table must be a string at ${JSON.stringify(location.path)}`);
    }
    assertIdentifier(tableName, 'Table name');
    const table = tableName;

    const { rows, append, column_types: columnTypes } = object;
    if (!Array.isArray(rows)) throw adapterError(`rows must be an array on table ${quote(table)}`);
    if (parent && append !== undefined && typeof append !== 'boolean') {
      throw adapterError(`append must be a boolean on table ${quote(table)}`);
    }

    // §8 defines append only for child tables, so a top-level one has no effect.
    const positional = parent !== undefined && parent.idIsStable && append !== true;

    const foreignKey = parent && `${parent.table}_id`;
    if (foreignKey !== undefined) assertIdentifier(foreignKey, 'Foreign key');

    const timestamps = this.parseColumnTypes(columnTypes, table, foreignKey);

    if (rows.length === 0) return;
    const draft = this.draftFor(table);
    if (foreignKey !== undefined) this.addColumn(draft, table, foreignKey, 'string', true);

    rows.forEach((row: unknown, index) => {
      const rowPath = [...location.path, index];
      if (!isRecord(row)) throw adapterError(`Row ${index} of table ${quote(table)} must be an object`);

      const id = this.resolveId(row, table, () =>
        positional
          ? // The key keeps apart two `children` keys that name the same table. Without it, their
            // positions would overlap, or a longer first list would shift the second.
            uuid5(JSON.stringify(['child', parent.table, parent.id, table, location.keys.at(-1), index]))
          : uuid5(JSON.stringify(['event', this.context.eventId, table, rowPath])),
      );

      const planned = this.planColumns(row, id, draft, table, {
        foreignKey,
        parentId: parent?.id,
        timestamps,
        keys: location.keys,
      });
      this.addRow(draft, planned);

      const idIsStable = row.id !== undefined || positional;
      this.planChildren(row.children, table, id, idIsStable, rowPath, location.keys);
    });
  }

  private parseColumnTypes(
    columnTypes: unknown,
    table: string,
    foreignKey: string | undefined,
  ): Set<string> {
    if (columnTypes === undefined) return new Set();
    if (!isRecord(columnTypes)) throw adapterError(`column_types must be an object on table ${quote(table)}`);
    for (const [column, type] of Object.entries(columnTypes)) {
      this.assertColumnName(column, table, foreignKey);
      if (type !== 'timestamp') {
        throw adapterError(`column_types may only declare timestamp, on ${quote(`${table}.${column}`)}`);
      }
    }
    return new Set(Object.keys(columnTypes));
  }

  private assertColumnName(column: string, table: string, foreignKey: string | undefined): void {
    if (ROW_KEYS.has(column) || SYSTEM_COLUMNS.has(column)) {
      throw adapterError(`Column ${quote(column)} on table ${quote(table)} is a reserved name`);
    }
    // A leading underscore, reserved for platform columns, fails this too.
    assertIdentifier(column, `Column on table ${quote(table)}:`);
    if (column === foreignKey) {
      throw adapterError(
        `Column ${quote(column)} on table ${quote(table)} collides with the injected foreign key`,
      );
    }
  }

  private resolveId(row: Record<string, unknown>, table: string, inject: () => string): string {
    const { id } = row;
    if (id === undefined) return inject();
    if (typeof id !== 'string' || id === '') {
      throw adapterError(`id must be a non-empty string on table ${quote(table)}`);
    }
    return id;
  }

  private planColumns(
    row: Record<string, unknown>,
    id: string,
    draft: TableDraft,
    table: string,
    options: {
      foreignKey: string | undefined;
      parentId: string | undefined;
      timestamps: Set<string>;
      keys: string[];
    },
  ): TableRow {
    const { foreignKey, parentId, timestamps, keys } = options;
    const planned: TableRow = { id, _event_seq: this.context.eventSeq };

    if (row._deleted === true) {
      planned._deleted_at = this.context.receivedAt;
    } else if (row._deleted !== undefined) {
      throw adapterError(`_deleted may only be true, on table ${quote(table)}`);
    }

    for (const [column, raw] of Object.entries(row)) {
      if (ROW_KEYS.has(column)) continue;
      this.assertColumnName(column, table, foreignKey);
      const value = raw === undefined ? null : raw;
      const type = this.inferType(value, column, table, timestamps, keys);
      if (type) this.addColumn(draft, table, column, type, type === 'timestamp');
      planned[column] = value;
    }

    if (foreignKey !== undefined) planned[foreignKey] = parentId;
    return planned;
  }

  private planChildren(
    children: unknown,
    table: string,
    id: string,
    idIsStable: boolean,
    rowPath: (string | number)[],
    keys: string[],
  ): void {
    if (children === undefined) return;
    if (!isRecord(children)) throw adapterError(`children must be an object on table ${quote(table)}`);

    const parent: ParentRow = { table, id, idIsStable };
    for (const [key, child] of Object.entries(children)) {
      const hint = isRecord(child) ? child.table : undefined;
      this.planObject(
        child,
        hint === undefined ? `${table}_${key}` : hint,
        { path: [...rowPath, key], keys: [...keys, key] },
        parent,
      );
    }
  }

  private inferType(
    value: unknown,
    column: string,
    table: string,
    timestamps: Set<string>,
    keys: string[],
  ): LogicalType | null {
    if (value === null) return null;
    const where = () => quote(`${table}.${column}`);

    // The contents of an opaque path vary, so every value there is json, even a scalar (§9).
    if (this.isOpaque(keys, column)) {
      if (!isJson(value)) throw adapterError(`${where()} holds a value JSON can't represent exactly`);
      return 'json';
    }

    if (timestamps.has(column)) {
      if (typeof value !== 'string' || !isValidTimestamp(value)) {
        throw adapterError(`${where()} must be an ISO 8601 string with a timezone`);
      }
      return 'timestamp';
    }

    switch (typeof value) {
      case 'string':
        return 'string';
      case 'boolean':
        return 'boolean';
      case 'number':
        if (!Number.isFinite(value)) throw adapterError(`${where()} holds NaN or Infinity`);
        return 'number';
      case 'object':
        throw adapterError(`${where()} holds an object or array, but is not at a declared opaque path`);
      default:
        throw adapterError(`${where()} holds a ${typeof value}, which is not a column value`);
    }
  }

  /**
   * Opaque paths describe the payload, and an adapter can lift a field out of a wrapper like
   * `data.object`. So the column's output path must match the end of a declared path. That means a
   * shallower column can use a deeper declaration of the same name, but a deeper column can't use a
   * shallower one, and a renamed field matches nothing.
   */
  private isOpaque(keys: string[], column: string): boolean {
    const path = [...keys, column];
    return this.opaquePaths.some(
      (declared) =>
        declared.length >= path.length &&
        path.every((segment, index) => segment === declared[declared.length - path.length + index]),
    );
  }

  private draftFor(table: string): TableDraft {
    let draft = this.drafts.get(table);
    if (!draft) {
      draft = { columns: new Map(), indexed: new Set(), rows: new Map() };
      this.drafts.set(table, draft);
    }
    return draft;
  }

  private addColumn(
    draft: TableDraft,
    table: string,
    column: string,
    type: LogicalType,
    indexed: boolean,
  ): void {
    const existing = draft.columns.get(column);
    if (existing && existing !== type) {
      throw new PlanFailure(
        'schema_conflict',
        `${quote(`${table}.${column}`)} is both ${existing} and ${type} within this event`,
      );
    }
    draft.columns.set(column, type);
    if (indexed) draft.indexed.add(column);
  }

  /**
   * One event can name a record twice, such as a customer embedded in several orders. Backends get
   * one row per `id`, merged as if written in order: later keys win, and the last row decides
   * `_deleted_at`, since a write that omits it restores the record (§11.2).
   */
  private addRow(draft: TableDraft, row: TableRow): void {
    const earlier = draft.rows.get(row.id);
    if (!earlier) {
      draft.rows.set(row.id, row);
      return;
    }
    const merged: TableRow = { ...earlier, ...row };
    if (row._deleted_at === undefined) delete merged._deleted_at;
    draft.rows.set(row.id, merged);
  }
}

/** Checks a whole json value. `undefined` is out too, since serializing it would change the value. */
function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

function toPlan(drafts: Map<string, TableDraft>): WritePlan {
  const changes: SchemaChange[] = [];
  const tables: TableRows[] = [];
  for (const [table, draft] of drafts) {
    changes.push({ kind: 'create_table', table });
    for (const [column, type] of draft.columns) {
      changes.push({ kind: 'add_column', table, column, type });
      if (draft.indexed.has(column)) changes.push({ kind: 'add_index', table, column });
    }
    tables.push({
      table,
      columns: Object.fromEntries(draft.columns),
      rows: [...draft.rows.values()],
    });
  }
  return { changes, tables };
}

/** Turns one event's validated adapter output into schema changes and rows. */
export function planWrite(output: AdapterResult, context: PlanContext): PlanResult {
  try {
    const planner = new Planner(context);
    const objects: unknown[] = Array.isArray(output) ? output : [output];
    objects.forEach((object, index) => {
      const table = isRecord(object) ? object.table : undefined;
      planner.planObject(object, table, { path: [index], keys: [] });
    });
    return { ok: true, plan: toPlan(planner.drafts) };
  } catch (error) {
    if (error instanceof PlanFailure) return { ok: false, reason: error.reason, detail: error.message };
    if (error instanceof OpaquePathError) {
      return { ok: false, reason: 'adapter_error', detail: error.message };
    }
    // Output that nests too deeply or refers to itself overflows the stack. A retry can't fix that.
    if (error instanceof RangeError) {
      return { ok: false, reason: 'adapter_error', detail: 'Output is nested too deeply' };
    }
    throw error;
  }
}

// The adapter contract (PRD §8 and §12). These types describe output that has passed the
// platform's runtime validation. Adapter code is untrusted JavaScript, so its raw return value is
// `unknown` until then.

/** Any JSON value. A column may hold an object or array only at a declared opaque path (§9). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A value stored in a column. A `timestamp` column holds an ISO 8601 string with a timezone. */
export type ColumnValue = JsonValue;

/**
 * Keyed by the child table's key, which names the table `{parent_table}_{key}` unless the child
 * sets its own `table`.
 */
export type RowChildren = Record<string, ChildObject>;

/**
 * Every value a row's index signature must admit. TypeScript requires each declared key to fit the
 * index signature, so this also includes `children`. `id` and `_deleted` already fit `ColumnValue`.
 */
export type RowValue = ColumnValue | RowChildren | undefined;

export interface IntermediateRow {
  /** If omitted, the platform injects a deterministic UUIDv5. */
  id?: string;
  /** Marks the record deleted. Fields included on the row are still written. */
  _deleted?: true;
  /** Reserved, so a payload field with this name must be renamed. */
  children?: RowChildren;
  [column: string]: RowValue;
}

/** A table nested under a row's `children`. It may omit `table`. */
export interface ChildObject {
  table?: string;
  rows: IntermediateRow[];
  /** Child tables: each event adds rows, instead of updating by position. */
  append?: boolean;
  /** Types that can't be inferred from a JSON value. */
  column_types?: Record<string, 'timestamp'>;
}

/** A top-level table. `table` is required, since there is no type to default to. */
export interface IntermediateObject extends ChildObject {
  table: string;
}

/** What an adapter returns. An array writes several top-level tables from one event. */
export type AdapterResult = IntermediateObject | IntermediateObject[];

/** The logged request (§6.2), with obvious auth already removed. */
export interface AdapterRequest {
  method: string;
  path: string;
  /** The raw query string, without the leading `?`. Empty when there is none. */
  query: string;
  headers: Record<string, string>;
}

/** The argument an adapter is called with (§12). */
export interface AdapterPayload {
  /** The parsed body. `null` for a `DELETE` with no body. */
  data: unknown;
  request: AdapterRequest;
}

// The storage backend contract (PRD §11.1). The pipeline above it knows nothing about the store.

export type LogicalType = 'string' | 'number' | 'boolean' | 'timestamp' | 'json';

export interface StoreConfig {
  /** From account_stores, never from the slug. */
  namespace: string;
  /** From account_stores. */
  connection: Record<string, unknown>;
  /** Decrypted by the platform. */
  credentials?: Record<string, unknown>;
}

/** Can only express additive changes, so backends generate no destructive DDL (§9). */
export type SchemaChange =
  /** Includes `id` and the platform columns (§9). */
  | { kind: 'create_table'; table: string }
  | { kind: 'add_column'; table: string; column: string; type: LogicalType }
  | { kind: 'add_index'; table: string; column: string };

/**
 * One row to merge. An absent key keeps the stored value, and `null` clears it. The platform has
 * already converted `undefined` to `null`.
 */
export interface TableRow {
  id: string;
  /**
   * The writing event's `events.seq`, as decimal text. pg returns BIGINT as a string, and a number
   * loses precision above 2^53. Compare it in SQL, not as text in JavaScript.
   */
  _event_seq: string;
  /**
   * Marks the record deleted, set to the deleting event's `received_at` so replays match. Only a
   * write at or above the row's `_event_seq` can change it: it sets it if included and clears it if
   * not, the one exception to an absent key keeping its value. A lower write never touches it, even
   * under the MVP rule that fills `NULL` columns (§8, §11.2).
   */
  _deleted_at?: string;
  [column: string]: unknown;
}

export interface TableRows {
  table: string;
  /** The columns these rows use, not counting the platform columns. */
  columns: Record<string, LogicalType>;
  rows: TableRow[];
}

/**
 * `applySchema` and `write` run for each event, and must throw every failure as a `StorageError`
 * (§11.2). A worker treats any other error as retryable.
 */
export interface StorageBackend {
  readonly capabilities: {
    /** A `write()` commits fully or not at all. */
    atomicWrites: boolean;
    /** When a repeated row stops being visible as a duplicate. */
    idempotency: 'immediate' | 'eventual';
  };

  /** Returns the read-only credentials. */
  provision(store: StoreConfig): Promise<Record<string, unknown>>;
  applySchema(store: StoreConfig, changes: SchemaChange[]): Promise<void>;
  /** Receives all rows for one event. */
  write(store: StoreConfig, tables: TableRows[]): Promise<void>;
  health(store: StoreConfig): Promise<void>;
}

export class StorageError extends Error {
  /** True: stays in the queue with backoff. False: quarantined as `write_error`. */
  readonly retryable: boolean;

  /** `retryable` is required, so a backend can't throw one without classifying it. */
  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.retryable = options.retryable;
  }
}

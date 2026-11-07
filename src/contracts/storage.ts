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

export interface TableRows {
  table: string;
  /** The columns these rows use. */
  columns: Record<string, LogicalType>;
  /** Every row has `id` and `_event_seq`. An absent key keeps the stored value. */
  rows: Record<string, unknown>[];
}

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
  /** Receives all rows for one event. Every failure must be thrown as a `StorageError` (§11.2). */
  write(store: StoreConfig, tables: TableRows[]): Promise<void>;
  health(store: StoreConfig): Promise<void>;
}

export class StorageError extends Error {
  /** True: stays in the queue with backoff. False: quarantined as `write_error`. */
  readonly retryable: boolean;

  /** `retryable` is required, so a backend can't throw one without classifying it. */
  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'StorageError';
    this.retryable = options.retryable;
  }
}

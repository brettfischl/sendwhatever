import pg from 'pg';
import { StorageError } from '../../contracts/index.js';

/**
 * SQLSTATE classes that mean this event's data or shape can never be written, so retrying can't
 * help: cardinality, data exceptions, constraints, unsupported features, missing databases and
 * schemas, undefined or invalid objects, and limits such as the column cap (§15).
 *
 * Everything else stays retryable, including bad logins and revoked privileges. Those are platform
 * problems rather than problems with the event, so they shouldn't quarantine every event in the
 * queue (§10.1).
 */
const PERMANENT_CLASSES = new Set(['0A', '21', '22', '23', '3D', '3F', '42', '54']);

/** In class 42, but caused by configuration rather than the event. */
const RETRYABLE_CODES = new Set(['42501']);

/** Overlapping `IF NOT EXISTS` DDL can still hit these. A retry finds the object and succeeds. */
const DDL_RACE_CODES = new Set(['23505', '42P04', '42P07', '42710']);

export function isRetryable(error: unknown, options: { ddl?: boolean } = {}): boolean {
  if (error instanceof StorageError) return error.retryable;
  if (error instanceof pg.DatabaseError) {
    const code = error.code ?? '';
    if (RETRYABLE_CODES.has(code)) return true;
    if (options.ddl && DDL_RACE_CODES.has(code)) return true;
    return !PERMANENT_CLASSES.has(code.slice(0, 2));
  }
  // Values that can't be serialized fail the same way every time. Network failures and pool
  // timeouts arrive as plain errors, and those are worth retrying.
  return !(error instanceof TypeError || error instanceof RangeError);
}

export function toStorageError(
  operation: string,
  error: unknown,
  options: { ddl?: boolean } = {},
): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new StorageError(`Postgres ${operation} failed: ${message}`, {
    retryable: isRetryable(error, options),
    cause: error,
  });
}

import type { HttpBindings } from '@hono/node-server';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { StorageBackend } from '../contracts/index.js';

export interface AppDeps {
  /** The application database (sw_app). */
  appDb: pg.Pool;
  backend: StorageBackend;
  config: Pick<
    Config,
    'postgresPort' | 'dataDbPassword' | 'encryptionKey' | 'internalApiToken' | 'port'
  >;
}

/**
 * Hono environment: route modules read dependencies with `c.get('deps')`. `c.env.incoming` is the
 * Node request, but `c.env` is undefined under `app.request()` in tests, so read it as `c.env?.incoming`.
 */
export type AppEnv = { Bindings: HttpBindings; Variables: { deps: AppDeps } };

/** An error with the status and message the client should see. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

/** True for a lost or refused database connection, which the server reports as 503. */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, errors, message } = error as {
    code?: string;
    errors?: unknown[];
    message?: string;
  };
  if (code && CONNECTION_ERROR_CODES.has(code)) return true;
  if (errors?.some(isConnectionError)) return true;
  return (
    message === 'Connection terminated unexpectedly' ||
    message === 'timeout exceeded when trying to connect'
  );
}

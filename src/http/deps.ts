import type pg from 'pg';
import type { Config } from '../config.js';
import type { StorageBackend } from '../contracts/index.js';

export interface AppDeps {
  /** The application database (sw_app). */
  appDb: pg.Pool;
  backend: StorageBackend;
  config: Pick<Config, 'postgresPort' | 'dataDbPassword' | 'encryptionKey'>;
}

/** Hono environment: route modules read dependencies with `c.get('deps')`. */
export type AppEnv = { Variables: { deps: AppDeps } };

/** An error with the status and message the client should see. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

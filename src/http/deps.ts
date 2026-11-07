import type { HttpBindings } from '@hono/node-server';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { StorageBackend } from '../contracts/index.js';

export interface AppDeps {
  /** The application database (sw_app). */
  appDb: pg.Pool;
  backend: StorageBackend;
  config: Pick<Config, 'postgresPort' | 'dataDbPassword' | 'encryptionKey'>;
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

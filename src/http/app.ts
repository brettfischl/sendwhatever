import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HttpError, type AppDeps, type AppEnv } from './deps.js';
import { accountRoutes } from './routes/accounts.js';
import { ingestRoutes } from './routes/ingest.js';

export const MAX_BODY_BYTES = 25 * 1024 * 1024;

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

/** Builds the app from injected dependencies, so tests call `app.request()` with no port. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'body too large' }, 413),
    }),
  );

  app.get('/healthz', async (c) => {
    await deps.appDb.query('SELECT 1');
    return c.json({ status: 'ok' });
  });

  // Mount each route module here, one line each.
  app.route('/accounts', accountRoutes);
  app.route('/ingest', ingestRoutes);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (isConnectionError(error)) return c.json({ error: 'database unavailable' }, 503);
    console.error(error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

function isConnectionError(error: unknown): boolean {
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

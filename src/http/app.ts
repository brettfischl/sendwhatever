import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminRoutes } from '../admin/index.js';
import { SandboxUnavailableError } from '../sandbox/index.js';
import { HttpError, isConnectionError, type AppDeps, type AppEnv } from './deps.js';
import { accountRoutes } from './routes/accounts.js';
import { adapterRoutes, quarantineRoutes } from './routes/adapters.js';
import { ingestRoutes } from './routes/ingest.js';
import { tableRoutes } from './routes/tables.js';

/** The most the adapter sandbox can reliably process (§13.1). Past about this, runs time out or run out of memory. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Builds the app from injected dependencies, so tests call `app.request()` with no port. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  // Hono routes on the normalized path, so `/ingest/../accounts` would reach an internal route without
  // auth. Refuse any request whose path, as the client sent it, has a `.` or `..` segment.
  app.use('*', async (c, next) => {
    if (hasDotSegment(c.env?.incoming?.url ?? new URL(c.req.url).pathname)) {
      return c.json({ error: 'not found' }, 404);
    }
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
  app.route('/tables', tableRoutes);
  app.route('/adapters', adapterRoutes);
  app.route('/quarantine', quarantineRoutes);
  app.route('/admin', adminRoutes);

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof SandboxUnavailableError) {
      return c.json({ error: 'The adapter sandbox is unavailable. Try again.' }, 503);
    }
    if (isConnectionError(error)) return c.json({ error: 'database unavailable' }, 503);
    console.error(error);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

function hasDotSegment(target: string): boolean {
  return target
    .split('?', 1)[0]!
    .split('/')
    .some((segment) => {
      try {
        segment = decodeURIComponent(segment);
      } catch {
        // Not decodable, so it can't be a dot segment.
      }
      return segment === '.' || segment === '..';
    });
}

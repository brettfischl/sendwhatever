import { serve } from '@hono/node-server';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { ensureSuperAdmin } from '../admin/users.js';
import { PostgresBackend } from '../storage/postgres/index.js';
import { createApp } from './app.js';

const config = loadConfig();
// Without a limit, a request waits forever on a database that doesn't answer or a pool in full use,
// where §13.1 promises a 503.
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl, connectionTimeoutMillis: 5_000 });
// An idle connection that drops would otherwise crash the process.
appDb.on('error', (error) => console.error('app database pool error:', error.message));

if (!config.internalApiToken) {
  console.warn('INTERNAL_API_TOKEN is not set, so the account, adapter and quarantine routes refuse every request.');
}
await ensureSuperAdmin(appDb, config.adminEmail, config.adminPassword);

const backend = new PostgresBackend();
const app = createApp({ appDb, backend, config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`sendwhatever listening on http://${info.address}:${info.port}`);
});

/** Most requests finish well within this. One cut off here is safe for a client that retries. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

// One Ctrl-C can arrive several times, from the terminal and again from npm passing it on, so only the
// first counts. The pools close after the last request, which may still need them.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      console.error('Running requests did not finish in time, so exiting without them');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => {
      Promise.all([appDb.end(), backend.close()]).then(
        () => process.exit(0),
        (error: Error) => {
          console.error(`Shutdown failed: ${error.message}`);
          process.exit(1);
        },
      );
    });
  });
}

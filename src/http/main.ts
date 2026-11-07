import { serve } from '@hono/node-server';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { PostgresBackend } from '../storage/postgres/index.js';
import { createApp } from './app.js';

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
// An idle connection that drops would otherwise crash the process.
appDb.on('error', (error) => console.error('app database pool error:', error.message));

const app = createApp({ appDb, backend: new PostgresBackend(), config });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`sendwhatever listening on http://${info.address}:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void appDb.end().finally(() => process.exit(0));
  });
}

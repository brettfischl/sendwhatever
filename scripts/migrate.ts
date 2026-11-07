import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { loadConfig } from '../src/config.js';

await runner({
  databaseUrl: loadConfig().appDatabaseUrl,
  dir: fileURLToPath(new URL('../migrations/app', import.meta.url)),
  migrationsTable: 'schema_migrations',
  direction: 'up',
});

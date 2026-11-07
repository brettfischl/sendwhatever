// `npm run seed`: the demo account, ready for `npm run demo`. Safe to re-run.
import pg from 'pg';
import { DEFAULT_ACCOUNT_SLUG } from '../demo/config.js';
import { SEED_FILE } from '../demo/seed-file.js';
import { loadConfig } from '../src/config.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { seedAccount } from './seed-account.js';

const CONNECT_TIMEOUT_MS = 5_000;

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
appDb.on('error', (error) => console.error('app database pool error:', error.message));
const backend = new PostgresBackend();

try {
  await seedAccount({ appDb, backend, config }, { slug: DEFAULT_ACCOUNT_SLUG, file: SEED_FILE });
} catch (error) {
  console.error(`Seed failed: ${(error as Error).message}`);
  console.error('Postgres must be up and migrated first. npm run setup does both.');
  process.exitCode = 1;
} finally {
  await Promise.all([appDb.end(), backend.close()]);
}

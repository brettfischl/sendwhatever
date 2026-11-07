// The local file `npm run seed` writes and `npm run demo` reads. It holds secrets, so it's gitignored
// and mode 600.
import { readFileSync } from 'node:fs';
import { chmod, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { isActiveApiKey } from '../src/accounts/api-keys.js';
import type { ReadLogin } from '../src/accounts/read-login.js';

export const SEED_FILE = fileURLToPath(new URL('../.demo-seed.json', import.meta.url));

const FILE_MODE = 0o600;
const CHECK_TIMEOUT_MS = 3_000;
const STUB_HINT = 'To use the built-in stub instead, run INGEST_URL= npm run demo.';

export interface SeedFile {
  slug: string;
  ingestUrl: string;
  apiKey: string;
  /** For the live tables panel. SW_ENCRYPTION_KEY stays in .env, so this file holds no second copy. */
  appDatabaseUrl: string;
  /** The store's read-only login. */
  database: ReadLogin;
}

/** Undefined when there's no file. Throws on one that can't be used, and the message holds no contents. */
export function readSeedFile(path: string): SeedFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let seed: Partial<SeedFile> | null;
  try {
    seed = JSON.parse(text) as Partial<SeedFile> | null;
  } catch {
    seed = null;
  }
  const usable =
    seed &&
    typeof seed.slug === 'string' &&
    typeof seed.ingestUrl === 'string' &&
    typeof seed.apiKey === 'string' &&
    typeof seed.appDatabaseUrl === 'string';
  if (!usable) throw new Error(`${path} can't be read. Run npm run seed to replace it.`);
  return seed as SeedFile;
}

/**
 * Returns whether the contents changed. Unchanged contents aren't rewritten, but the mode is still
 * corrected. A new file replaces the old one in one step, so a crash can't leave half a file, and the
 * new file's mode doesn't depend on the old one's.
 */
export async function writeSeedFile(path: string, seed: SeedFile): Promise<boolean> {
  const text = `${JSON.stringify(seed, null, 2)}\n`;
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (current === text) {
    await chmod(path, FILE_MODE);
    return false;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, text, { mode: FILE_MODE, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

/**
 * Fills in what the environment leaves unset. The key belongs to one account on one service, so it's
 * never sent to a different target: with another URL or slug and no key of its own, the demo behaves as
 * if the file weren't there, including failing when INGEST_URL has no INGEST_API_KEY.
 */
export function applySeedFile(
  env: NodeJS.ProcessEnv,
  seed: SeedFile | undefined,
): { env: NodeJS.ProcessEnv; usesSeedKey: boolean } {
  if (!seed || (env.INGEST_URL ?? seed.ingestUrl) !== seed.ingestUrl) return { env, usesSeedKey: false };
  const accountSlug = env.ACCOUNT_SLUG ?? seed.slug;
  const usesSeedKey = !env.INGEST_API_KEY;
  if (usesSeedKey && accountSlug !== seed.slug) return { env, usesSeedKey: false };
  return {
    env: {
      ...env,
      INGEST_URL: seed.ingestUrl,
      INGEST_API_KEY: env.INGEST_API_KEY || seed.apiKey,
      ACCOUNT_SLUG: accountSlug,
      // An empty line, as in a .env copied from .env.example, doesn't turn the panel off.
      DEMO_APP_DATABASE_URL: env.DEMO_APP_DATABASE_URL || seed.appDatabaseUrl,
    },
    usesSeedKey,
  };
}

/**
 * Throws if the seeded key won't be accepted, as after a volume rebuild, so the demo stops at startup
 * instead of sending every request with a dead key. It asks the database because the server may not be
 * running yet. `appDatabaseUrl` is the one the demo uses, which the environment may have overridden.
 */
export async function assertSeedKeyLive(seed: SeedFile, appDatabaseUrl = seed.appDatabaseUrl): Promise<void> {
  const client = new pg.Client({
    connectionString: appDatabaseUrl,
    connectionTimeoutMillis: CHECK_TIMEOUT_MS,
  });
  // Without a listener, losing the connection during the check would crash the process.
  client.on('error', () => undefined);
  let live: boolean;
  try {
    await client.connect();
    const account = (
      await client.query<{ id: string }>(`SELECT id FROM accounts WHERE slug = $1 AND status = 'active'`, [
        seed.slug,
      ])
    ).rows[0];
    live = account !== undefined && (await isActiveApiKey(client, account.id, seed.apiKey));
  } catch (error) {
    throw new Error(
      `Couldn't check the API key from npm run seed: ${(error as Error).message}. Start Postgres with docker compose up -d --wait, then run npm run seed. ${STUB_HINT}`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
  if (!live) {
    throw new Error(
      `The API key from npm run seed no longer works for account ${seed.slug}, perhaps because the database was rebuilt. Run npm run seed, then start the demo again. ${STUB_HINT}`,
    );
  }
}

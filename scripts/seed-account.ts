// What `npm run seed` does, for any account. scripts/seed.ts names the account and the file.
import type pg from 'pg';
import { readSeedFile, writeSeedFile, type SeedFile } from '../demo/seed-file.js';
import { createApiKey, isActiveApiKey } from '../src/accounts/api-keys.js';
import { AccountError, createAccount, type CreatedAccount } from '../src/accounts/create.js';
import { loadAccountReadLogin } from '../src/accounts/read-login.js';
import { ensureSuperAdmin } from '../src/admin/users.js';
import type { Config } from '../src/config.js';
import type { AppDeps } from '../src/http/deps.js';

export interface SeedOptions {
  slug: string;
  file: string;
}

export interface SeedResult {
  accountCreated: boolean;
  memberAdded: boolean;
  key: 'created' | 'reused';
  fileChanged: boolean;
}

/**
 * The user to make a member: the one named by ADMIN_EMAIL, or else the oldest super admin. The server
 * creates the first super admin when it starts, and the seed may run before it ever has.
 */
export async function ensureSeedAdmin(
  db: Pick<pg.Pool, 'query'>,
  email: string | undefined,
  password: string | undefined,
): Promise<{ id: string; email: string }> {
  await ensureSuperAdmin(db, email, password);
  const admin = (
    await db.query<{ id: string; email: string }>(
      `SELECT id, email FROM users
        WHERE disabled_at IS NULL AND (lower(email) = lower($1::text) OR is_super_admin)
        ORDER BY lower(email) = lower($1::text) DESC NULLS LAST, created_at, id
        LIMIT 1`,
      [email?.trim()],
    )
  ).rows[0];
  if (!admin) throw new Error('There is no admin to add. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env.');
  return admin;
}

/**
 * Brings the account, its membership and the local file to the wanted state, and changes nothing that's
 * already there. An active store's password is never rotated, and a key that's still active is never
 * revoked. The only secret that can't be read back is the API key, so a new one is added when the file
 * has lost it.
 */
export async function seedAccount(
  deps: Pick<AppDeps, 'appDb' | 'backend'> & { config: Config },
  { slug, file }: SeedOptions,
): Promise<SeedResult> {
  const { appDb, config } = deps;
  const admin = await ensureSeedAdmin(appDb, config.adminEmail, config.adminPassword);

  const existing = (
    await appDb.query<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE slug = $1', [slug])
  ).rows[0];
  if (existing && existing.status !== 'active' && existing.status !== 'provisioning') {
    throw new Error(`Account ${slug} is ${existing.status}. Enable it in the admin, then run this again.`);
  }

  let accountId: string;
  let apiKey: string;
  let key: SeedResult['key'];
  // This also finishes an account left `provisioning` by a failed attempt.
  const created = existing?.status === 'active' ? undefined : await createIfStillMissing(deps, slug);
  const accountCreated = created !== undefined;
  if (created) {
    accountId = created.accountId;
    apiKey = created.apiKey;
    key = 'created';
  } else {
    accountId = (
      await appDb.query<{ id: string }>(`SELECT id FROM accounts WHERE slug = $1`, [slug])
    ).rows[0]!.id;
    const saved = readSavedKey(file);
    if (saved && (await isActiveApiKey(appDb, accountId, saved))) {
      apiKey = saved;
      key = 'reused';
    } else {
      apiKey = await createApiKey(appDb, accountId);
      key = 'created';
    }
  }

  const { rowCount } = await appDb.query(
    'INSERT INTO account_members (account_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [accountId, admin.id],
  );
  const memberAdded = rowCount === 1;

  const database = await loadAccountReadLogin(deps, accountId);
  if (!database) throw new Error(`Account ${slug} has no active store with a read-only login.`);
  const seed: SeedFile = {
    slug,
    ingestUrl: `http://localhost:${config.port}/ingest`,
    apiKey,
    appDatabaseUrl: config.appDatabaseUrl,
    database,
  };
  const fileChanged = await writeSeedFile(file, seed);

  console.log(`Account ${slug}: ${accountCreated ? 'created' : 'already exists'}.`);
  console.log(`Admin ${admin.email}: ${memberAdded ? 'added as a member' : 'already a member'}.`);
  console.log(`API key: ${key === 'reused' ? 'reused' : 'new key created'}.`);
  console.log(`Local file ${file}: ${fileChanged ? 'written' : 'unchanged'}.`);
  console.log(`The demo will send to ${seed.ingestUrl}.`);
  if (key === 'created') console.log('If npm run demo is running, restart it to use the new key.');

  return { accountCreated, memberAdded, key, fileChanged };
}

/** Undefined when someone else, such as a second seed, activated it after this run looked. */
async function createIfStillMissing(
  deps: Parameters<typeof createAccount>[0],
  slug: string,
): Promise<CreatedAccount | undefined> {
  try {
    return await createAccount(deps, { slug });
  } catch (error) {
    if (error instanceof AccountError && error.code === 'exists') return undefined;
    throw error;
  }
}

/** A file that can't be read is the same as a missing one here: this run replaces it. */
function readSavedKey(file: string): string | undefined {
  try {
    return readSeedFile(file)?.apiKey;
  } catch {
    return undefined;
  }
}

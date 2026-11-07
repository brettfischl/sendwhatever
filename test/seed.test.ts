// Uses a generated slug and a temporary file: this database is shared, and `demo` belongs to the developer.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSeedKeyLive, readSeedFile, type SeedFile } from '../demo/seed-file.js';
import { ensureSeedAdmin, seedAccount } from '../scripts/seed-account.js';
import { createUser } from '../src/admin/users.js';
import { loadConfig } from '../src/config.js';
import { hashApiKey } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const tag = randomBytes(5).toString('hex');
const slug = `seed-${tag}`;
const adminEmail = `seed-${tag}@example.test`;
const adminPassword = `seed-password-${tag}`;
const config = { ...loadConfig(), adminEmail, adminPassword };
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const deps = { appDb, backend, config };
const dir = mkdtempSync(join(tmpdir(), 'sw-seed-'));
const file = join(dir, 'seed.json');
const options = { slug, file };
let created: { id: string };
beforeAll(async () => {
  created = await createUser(appDb, { email: adminEmail, password: adminPassword, isSuperAdmin: true });
});

const saved = () => readSeedFile(file) as SeedFile;

async function state() {
  const account = (await appDb.query<{ id: string }>('SELECT id FROM accounts WHERE slug = $1', [slug])).rows[0]!;
  const keys = await appDb.query<{ key_hash: string; revoked_at: Date | null }>(
    'SELECT key_hash, revoked_at FROM api_keys WHERE account_id = $1',
    [account.id],
  );
  const stores = await appDb.query<{ read_credentials: Buffer }>(
    'SELECT read_credentials FROM account_stores WHERE account_id = $1',
    [account.id],
  );
  const members = await appDb.query<{ user_id: string }>(
    'SELECT user_id FROM account_members WHERE account_id = $1',
    [account.id],
  );
  return {
    accountId: account.id,
    keys: keys.rows,
    login: stores.rows.map((row) => row.read_credentials.toString('hex')),
    members: members.rows.map((row) => row.user_id),
  };
}

const output: string[] = [];
beforeEach(() => {
  const capture = (...args: unknown[]) => void output.push(args.join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'postgres',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  const { rows } = await appDb.query<{ id: string }>('SELECT id FROM accounts WHERE slug = $1', [slug]);
  for (const { id } of rows) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
    await appDb.query('DELETE FROM account_members WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM api_keys WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM account_stores WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  if (created) await appDb.query('DELETE FROM users WHERE id = $1', [created.id]);
  await admin.end();
  await backend.close();
  await appDb.end();
});

// These run in order, each from the state the one before left.
describe('seedAccount', () => {
  it('first run: creates the account, its store, the membership and a mode 600 file', async () => {
    const result = await seedAccount(deps, options);
    expect(result).toEqual({ accountCreated: true, memberAdded: true, key: 'created', fileChanged: true });

    const after = await state();
    expect(after.members).toEqual([created.id]);
    expect(after.keys).toHaveLength(1);
    expect(after.login).toHaveLength(1);

    const seed = saved();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(seed.slug).toBe(slug);
    expect(seed.ingestUrl).toBe(`http://localhost:${config.port}/ingest`);
    expect(seed.appDatabaseUrl).toBe(config.appDatabaseUrl);
    expect(after.keys[0]!.key_hash).toBe(hashApiKey(seed.apiKey));

    // The saved login really opens the store.
    const reader = new pg.Client(seed.database);
    await reader.connect();
    await reader.query('SELECT 1');
    await reader.end();

    await expect(assertSeedKeyLive(seed)).resolves.toBeUndefined();
  });

  it('re-run: changes nothing, and never reprovisions', async () => {
    const before = await state();
    const text = readFileSync(file, 'utf8');
    const modified = statSync(file).mtimeMs;
    const provision = vi.spyOn(backend, 'provision');

    const result = await seedAccount(deps, options);

    expect(result).toEqual({ accountCreated: false, memberAdded: false, key: 'reused', fileChanged: false });
    expect(provision).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mtimeMs).toBe(modified);
  });

  it('missing file: adds one key and leaves the working one active', async () => {
    const before = await state();
    rmSync(file);

    const result = await seedAccount(deps, options);

    expect(result).toMatchObject({ accountCreated: false, key: 'created', fileChanged: true });
    const after = await state();
    expect(after.login).toEqual(before.login);
    expect(after.keys).toHaveLength(before.keys.length + 1);
    expect(after.keys.filter((key) => key.revoked_at)).toEqual([]);
    expect(after.keys.map((key) => key.key_hash)).toContain(hashApiKey(saved().apiKey));
  });

  it('damaged file: replaced with a working key', async () => {
    writeFileSync(file, 'not json');
    expect((await seedAccount(deps, options)).key).toBe('created');
    await expect(assertSeedKeyLive(saved())).resolves.toBeUndefined();
  });

  it('dead key: the demo refuses it, and a re-run replaces it', async () => {
    const dead = saved();
    await appDb.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashApiKey(dead.apiKey)]);
    await expect(assertSeedKeyLive(dead)).rejects.toThrow(/npm run seed/);

    expect((await seedAccount(deps, options)).key).toBe('created');

    const fresh = saved();
    expect(fresh.apiKey).not.toBe(dead.apiKey);
    await expect(assertSeedKeyLive(fresh)).resolves.toBeUndefined();
    expect((await seedAccount(deps, options)).key).toBe('reused');
  });

  it('a file left from a rebuilt database: the demo refuses it, and a re-run replaces it', async () => {
    const seed = saved();
    const leftover = { ...seed, apiKey: 'sw_from-a-deleted-volume' };
    writeFileSync(file, JSON.stringify(leftover));
    await expect(assertSeedKeyLive(leftover)).rejects.toThrow(/no longer works/);
    await expect(assertSeedKeyLive({ ...seed, slug: `gone-${tag}` })).rejects.toThrow(/no longer works/);

    expect((await seedAccount(deps, options)).key).toBe('created');
    expect(saved().apiKey).not.toBe(leftover.apiKey);
  });

  it('reports an unreachable database without showing its password', async () => {
    const url = new URL(config.appDatabaseUrl);
    url.port = '1';
    const error = (await assertSeedKeyLive({ ...saved(), appDatabaseUrl: url.href }).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/Couldn't check/);
    expect(error.message).not.toContain(url.password);
  });

  it('makes the configured admin a member, and adds one missing after a removal', async () => {
    const { accountId } = await state();
    await appDb.query('DELETE FROM account_members WHERE account_id = $1', [accountId]);
    const result = await seedAccount(deps, options);
    expect(result).toMatchObject({ memberAdded: true, key: 'reused', fileChanged: false });
    expect((await state()).members).toEqual([created.id]);
  });

  it('never prints a secret', () => {
    const seed = saved();
    const printed = output.join('\n');
    expect(printed).toContain(slug);
    expect(printed).toContain(file);
    for (const secret of [
      seed.apiKey,
      seed.database.password,
      adminPassword,
      new URL(config.appDatabaseUrl).password,
      config.dataDbPassword,
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  it('refuses a disabled account rather than quietly enabling it', async () => {
    const { accountId } = await state();
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [accountId]);
    await expect(seedAccount(deps, options)).rejects.toThrow(/disabled/);
    const { rows } = await appDb.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId]);
    expect(rows[0]!.status).toBe('disabled');
    await appDb.query(`UPDATE accounts SET status = 'active' WHERE id = $1`, [accountId]);
  });
});

describe('ensureSeedAdmin', () => {
  // Rolls back, and demotes everyone first, so it doesn't depend on what the shared database holds.
  async function inEmptyTransaction(run: (db: pg.PoolClient) => Promise<void>) {
    const client = await appDb.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET is_super_admin = false WHERE is_super_admin');
      await run(client);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('creates the admin when the server has never run', async () => {
    await inEmptyTransaction(async (db) => {
      const email = `first-${tag}@example.test`;
      const admin = await ensureSeedAdmin(db, email, adminPassword);
      expect(admin.email).toBe(email);
      const { rows } = await db.query<{ is_super_admin: boolean }>('SELECT is_super_admin FROM users WHERE id = $1', [
        admin.id,
      ]);
      expect(rows[0]!.is_super_admin).toBe(true);
    });
  });

  it('finds the existing admin whatever the case of the email', async () => {
    const admin = await ensureSeedAdmin(appDb, adminEmail.toUpperCase(), adminPassword);
    expect(admin.id).toBe(created.id);
  });

  it('falls back to a super admin when ADMIN_EMAIL names nobody', async () => {
    await inEmptyTransaction(async (db) => {
      await db.query('UPDATE users SET is_super_admin = true WHERE id = $1', [created.id]);
      const admin = await ensureSeedAdmin(db, `nobody-${tag}@example.test`, adminPassword);
      expect(admin.id).toBe(created.id);
    });
  });

  it('fails clearly with no admin and nothing to create one from', async () => {
    await inEmptyTransaction(async (db) => {
      await expect(ensureSeedAdmin(db, undefined, undefined)).rejects.toThrow(/ADMIN_EMAIL/);
    });
  });
});

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AccountError, createAccount } from '../src/accounts/create.js';
import { loadConfig } from '../src/config.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';
import { dropDatabase } from './helpers/drop-database.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const deps = { appDb, backend: new PostgresBackend({ idleTimeoutMs: 50 }), config };
const slug = `ca-${randomBytes(5).toString('hex')}`;

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  const { rows } = await appDb.query<{ id: string }>('SELECT id FROM accounts WHERE slug = $1', [
    slug,
  ]);
  for (const { id } of rows) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
    await appDb.query('DELETE FROM api_keys WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM account_stores WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.end();
});

describe('createAccount', () => {
  it('creates an active account with a key and a read-only login, then reports exists', async () => {
    const created = await createAccount(deps, { slug });
    expect(created.slug).toBe(slug);
    expect(created.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.apiKey).toBeTruthy();
    expect(created.database.host).toBe('localhost');
    expect(created.database.user).toBeTruthy();

    const { rows } = await appDb.query<{ status: string }>(
      'SELECT status FROM accounts WHERE id = $1',
      [created.accountId],
    );
    expect(rows[0]!.status).toBe('active');

    const error = await createAccount(deps, { slug }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountError);
    expect((error as AccountError).code).toBe('exists');
  });

  it('throws typed errors for bad input', async () => {
    const code = async (input: Parameters<typeof createAccount>[1]) =>
      ((await createAccount(deps, input).catch((e: unknown) => e)) as AccountError).code;
    expect(await code({ slug: 'Not Valid' })).toBe('invalid_slug');
    expect(await code({ slug: undefined })).toBe('invalid_slug');
    expect(await code({ slug: 'fine-slug', storage: 'nope' })).toBe('invalid_storage');
  });
});

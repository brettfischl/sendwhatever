// Losing the application database while a request holds a client must return 503, not crash the
// process. Without a listener on the client, this file fails with an uncaught 'error' event.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { StorageBackend } from '../src/contracts/index.js';
import { activateAdapter } from '../src/adapters/index.js';
import { createApp } from '../src/http/app.js';

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'lost-connection-test-token';
const config = { ...loadConfig(), internalApiToken: TOKEN };
const killer = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 1 });
const slugs: string[] = [];

/** Ends a client's connection, and waits long enough for the client to notice. */
async function terminate(client: pg.PoolClient): Promise<void> {
  const { processID } = client as unknown as { processID: number };
  await killer.query('SELECT pg_terminate_backend($1)', [processID]);
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function newPool(): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.appDatabaseUrl, max: 3 });
  pool.on('error', () => {});
  return pool;
}

/** The connection goes right after BEGIN, while the client sits idle in its transaction. */
function loseAfterBegin(pool: pg.Pool): void {
  pool.on('acquire', (client) => {
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
      const result = await query(...args);
      if (args[0] === 'BEGIN') await terminate(client);
      return result;
    };
  });
}

const backend = (provision: StorageBackend['provision']): StorageBackend => ({
  capabilities: { atomicWrites: true, idempotency: 'immediate' },
  provision,
  applySchema: async () => {},
  write: async () => {},
  health: async () => {},
});
const login = async () => ({ user: 'unused', password: 'unused', database: 'unused' });

function postAccount(app: ReturnType<typeof createApp>, slug: string) {
  slugs.push(slug);
  return app.request('/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
}

const newSlug = () => `lost-${randomBytes(5).toString('hex')}`;

afterAll(async () => {
  const accounts = `(SELECT id FROM accounts WHERE slug = ANY($1))`;
  await killer.query(`DELETE FROM queue WHERE account_id IN ${accounts}`, [slugs]);
  await killer.query(`DELETE FROM adapters WHERE account_id IN ${accounts}`, [slugs]);
  await killer.query(`DELETE FROM events WHERE account_id IN ${accounts}`, [slugs]);
  await killer.query(`DELETE FROM api_keys WHERE account_id IN ${accounts}`, [slugs]);
  await killer.query(`DELETE FROM account_stores WHERE account_id IN ${accounts}`, [slugs]);
  await killer.query('DELETE FROM accounts WHERE slug = ANY($1)', [slugs]);
  await killer.end();
});

describe('losing the application database during a request', () => {
  it('returns 503 from POST /accounts, and a retry finishes the account', async () => {
    const pool = newPool();
    let held: pg.PoolClient | undefined;
    pool.on('acquire', (client) => {
      held ??= client;
    });
    let lose = true;
    const app = createApp({
      appDb: pool,
      backend: backend(async () => {
        if (lose) {
          lose = false;
          await terminate(held!);
        }
        return login();
      }),
      config,
    });

    const slug = newSlug();
    expect((await postAccount(app, slug)).status).toBe(503);
    slugs.pop();
    expect((await postAccount(app, slug)).status).toBe(201);
    await pool.end();
  });

  it('rejects from activateAdapter rather than crashing, and leaves the adapter inactive', async () => {
    const setup = newPool();
    const slug = newSlug();
    const created = await postAccount(createApp({ appDb: setup, backend: backend(login), config }), slug);
    const { account_id: accountId } = (await created.json()) as { account_id: string };
    await setup.end();
    const { rows } = await killer.query<{ id: string }>(
      `INSERT INTO adapters (account_id, op, fingerprint, version, code, validated_at)
       VALUES ($1, 'write', 'aaaaaaaaaaaaaaaa', 1, 'function adapt() {}', now()) RETURNING id`,
      [accountId],
    );
    const adapterId = rows[0]!.id;

    const pool = newPool();
    loseAfterBegin(pool);
    await expect(activateAdapter(pool, adapterId, { replacing: null })).rejects.toThrow();
    await pool.end();

    const after = await killer.query<{ active: boolean }>('SELECT active FROM adapters WHERE id = $1', [adapterId]);
    expect(after.rows[0]!.active).toBe(false);
  });

  it('returns 503 from /ingest mid-transaction, with nothing stored', async () => {
    const setup = newPool();
    const slug = newSlug();
    const created = await postAccount(createApp({ appDb: setup, backend: backend(login), config }), slug);
    const { api_key: apiKey, account_id: accountId } = (await created.json()) as { api_key: string; account_id: string };
    await setup.end();

    const pool = newPool();
    loseAfterBegin(pool);
    const app = createApp({ appDb: pool, backend: backend(login), config });
    const response = await app.request('/ingest', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'x-account-slug': slug },
      body: '{"a":1}',
    });
    expect(response.status).toBe(503);
    await pool.end();

    const events = await killer.query('SELECT 1 FROM events WHERE account_id = $1', [accountId]);
    expect(events.rowCount).toBe(0);
  });
});

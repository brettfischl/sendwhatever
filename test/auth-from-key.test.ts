import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccount } from '../src/accounts/create.js';
import { createApiKey } from '../src/accounts/api-keys.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { hashApiKey } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { removeAccount } from './helpers/remove-account.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

const tag = randomBytes(4).toString('hex');
const accountIds: string[] = [];

interface Acct {
  id: string;
  slug: string;
  ingestKey: string;
  readKey: string;
}

async function newAccount(label: string): Promise<Acct> {
  const created = await createAccount({ appDb, backend, config }, { slug: `afk-${label}-${tag}` });
  accountIds.push(created.accountId);
  return {
    id: created.accountId,
    slug: created.slug,
    ingestKey: created.apiKey,
    readKey: await createApiKey(appDb, created.accountId, 'read'),
  };
}

function ingest(path: string, auth: { bearer?: string; slug?: string }) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth.slug ? { 'x-account-slug': auth.slug } : {}),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify({ id: 'evt_1', type: 'customer.created' }),
  });
}

function tables(auth: { bearer?: string; slug?: string }, query = '') {
  return app.request(`/tables/orders${query}`, {
    headers: {
      ...(auth.slug ? { 'x-account-slug': auth.slug } : {}),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
  });
}

async function eventsOf(accountId: string) {
  const { rows } = await appDb.query<{ source: string; request: { query: string } }>(
    'SELECT source, request FROM events WHERE account_id = $1 ORDER BY seq',
    [accountId],
  );
  return rows;
}

let a: Acct;
let b: Acct;

beforeAll(async () => {
  a = await newAccount('a');
  b = await newAccount('b');
  // A row in a table the old hand-kept cleanup list missed: removeAccount must still succeed.
  await appDb.query(
    `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status)
     VALUES ($1, 'stripe', 'write', 'fp', 'failed')`,
    [b.id],
  );
});

afterAll(async () => {
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'postgres',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  for (const id of accountIds) await removeAccount(appDb, admin, id);
  await admin.end();
  await appDb.end();
});

describe('account from the key, with no X-Account-Slug', () => {
  it('accepts a bearer key and stores the event under the key\'s account', async () => {
    const res = await ingest('/ingest/orders', { bearer: a.ingestKey });
    expect(res.status).toBe(202);
    expect(await eventsOf(a.id)).toHaveLength(1);
    expect(await eventsOf(b.id)).toHaveLength(0);
  });

  it('accepts ?key= on a webhook URL and still strips it from the stored query', async () => {
    const res = await ingest(`/ingest/stripe?key=${b.ingestKey}&x=1`, {});
    expect(res.status).toBe(202);
    const [event] = await eventsOf(b.id);
    expect(event!.source).toBe('stripe');
    expect(event!.request.query).toBe('x=1');
    expect(JSON.stringify(event)).not.toContain(b.ingestKey);
  });

  it('answers 401 for no key, an unknown key, and a revoked key, never 404', async () => {
    const none = await ingest('/ingest/stripe', {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'invalid or missing API key' });
    expect((await ingest('/ingest/stripe?key=sw_unknown', {})).status).toBe(401);
    expect((await ingest('/ingest/stripe', { bearer: 'sw_unknown' })).status).toBe(401);

    const revoked = await createApiKey(appDb, a.id);
    await appDb.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashApiKey(revoked)]);
    expect((await ingest('/ingest/stripe', { bearer: revoked })).status).toBe(401);
    expect((await ingest(`/ingest/stripe?key=${revoked}`, {})).status).toBe(401);
  });

  it('answers 403 when the key\'s account is disabled', async () => {
    const c = await newAccount('c');
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [c.id]);
    expect((await ingest('/ingest/stripe', { bearer: c.ingestKey })).status).toBe(403);
    expect(await eventsOf(c.id)).toHaveLength(0);
  });

  it('still enforces scopes', async () => {
    // A read key on /ingest, and an ingest key on /tables.
    expect((await ingest('/ingest/stripe', { bearer: a.readKey })).status).toBe(401);
    expect((await ingest(`/ingest/stripe?key=${a.readKey}`, {})).status).toBe(401);
    expect((await tables({ bearer: a.ingestKey })).status).toBe(401);

    // A read key as a bearer passes auth, then finds no such table.
    const ok = await tables({ bearer: a.readKey });
    expect(ok.status).toBe(404);
    expect(await ok.json()).toEqual({ error: 'unknown table' });

    // /tables never takes the key from the URL.
    expect((await tables({}, `?key=${a.readKey}`)).status).toBe(401);
  });
});

describe('with X-Account-Slug, behavior is unchanged', () => {
  it('answers 401 for a slug of account A with a key of account B', async () => {
    const res = await ingest('/ingest/x', { slug: a.slug, bearer: b.ingestKey });
    expect(res.status).toBe(401);
  });

  it('answers 404 for an unknown slug', async () => {
    const res = await ingest('/ingest/x', { slug: 'no-such-acct', bearer: a.ingestKey });
    expect(res.status).toBe(404);
  });

  it('uses the slug\'s account when the key matches', async () => {
    const before = (await eventsOf(a.id)).length;
    expect((await ingest('/ingest/x', { slug: a.slug, bearer: a.ingestKey })).status).toBe(202);
    expect((await eventsOf(a.id)).length).toBe(before + 1);
  });
});

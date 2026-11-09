import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccount } from '../src/accounts/create.js';
import { createApiKey } from '../src/accounts/api-keys.js';
import { decryptJson } from '../src/secrets.js';
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

/** A POST to `/ingest/...` with exactly these headers, for cases `ingest()` can't express. */
function ingestWith(path: string, headers: Record<string, string>) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ id: 'evt_1', type: 'customer.created' }),
  });
}

function tables(auth: { bearer?: string; slug?: string }, query = '', table = 'shipments') {
  return app.request(`/tables/${table}${query}`, {
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

const countOf = async (accountId: string) => (await eventsOf(accountId)).length;

/** Runs a request that must be refused, and checks that neither A nor B got an event from it. */
async function expectNothingStored(run: () => Promise<Response> | Response, status: number): Promise<void> {
  const before = [await countOf(a.id), await countOf(b.id)];
  expect((await run()).status).toBe(status);
  expect([await countOf(a.id), await countOf(b.id)]).toEqual(before);
}

/** Puts one row in the account's `shipments` table, registered so `/tables` can read it. */
async function seedShipment(acct: Acct, rowId: string): Promise<void> {
  const { rows } = await appDb.query<{ id: string; namespace: string; connection: Record<string, unknown>; credentials: Buffer }>(
    `SELECT id, namespace, connection, credentials FROM account_stores WHERE account_id = $1 AND status = 'active'`,
    [acct.id],
  );
  const row = rows[0]!;
  const store = {
    namespace: row.namespace,
    connection: row.connection as { host: string; port: number; database: string },
    credentials: decryptJson(config.encryptionKey, row.credentials) as Record<string, unknown>,
  };
  await backend.applySchema(store, [
    { kind: 'create_table', table: 'shipments' },
    { kind: 'add_column', table: 'shipments', column: 'title', type: 'string' },
  ]);
  await backend.write(store, [
    { table: 'shipments', columns: { title: 'string' }, rows: [{ id: rowId, _event_seq: '1', title: rowId }] },
  ]);
  for (const [column, type] of [['id', 'string'], ['title', 'string']]) {
    await appDb.query(
      'INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, $2, $3, $4)',
      [row.id, 'shipments', column, type],
    );
  }
}

async function revokedKey(accountId: string, scope: 'ingest' | 'read' = 'ingest'): Promise<string> {
  const key = await createApiKey(appDb, accountId, scope);
  await appDb.query('UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1', [hashApiKey(key)]);
  return key;
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
  await seedShipment(a, 'ship-a');
  await seedShipment(b, 'ship-b');
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
    const [beforeA, beforeB] = [await countOf(a.id), await countOf(b.id)];
    const res = await ingest('/ingest/orders', { bearer: a.ingestKey });
    expect(res.status).toBe(202);
    expect(await countOf(a.id)).toBe(beforeA + 1);
    expect(await countOf(b.id)).toBe(beforeB);
  });

  it('accepts ?key= on a webhook URL and still strips it from the stored query', async () => {
    const before = await countOf(b.id);
    const res = await ingest(`/ingest/stripe?key=${b.ingestKey}&x=1`, {});
    expect(res.status).toBe(202);
    const [event] = (await eventsOf(b.id)).slice(before);
    expect(event!.source).toBe('stripe');
    expect(event!.request.query).toBe('x=1');
    expect(JSON.stringify(event)).not.toContain(b.ingestKey);
  });

  it('answers 401 for no key, an unknown key, and a revoked key, never 404', async () => {
    const none = await ingest('/ingest/stripe', {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'invalid or missing API key' });
    await expectNothingStored(() => ingest('/ingest/stripe', {}), 401);
    await expectNothingStored(() => ingest('/ingest/stripe?key=sw_unknown', {}), 401);
    await expectNothingStored(() => ingest('/ingest/stripe', { bearer: 'sw_unknown' }), 401);

    const revoked = await revokedKey(a.id);
    await expectNothingStored(() => ingest('/ingest/stripe', { bearer: revoked }), 401);
    await expectNothingStored(() => ingest(`/ingest/stripe?key=${revoked}`, {}), 401);
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
    const ok = await tables({ bearer: a.readKey }, '', 'orders');
    expect(ok.status).toBe(404);
    expect(await ok.json()).toEqual({ error: 'unknown table' });

    // /tables never takes the key from the URL.
    expect((await tables({}, `?key=${a.readKey}`)).status).toBe(401);
  });
});

describe('account from the key: edge cases', () => {
  it('answers 403 and stores nothing for an account that is still provisioning', async () => {
    const p = await newAccount('p');
    await appDb.query(`UPDATE accounts SET status = 'provisioning' WHERE id = $1`, [p.id]);
    const before = await countOf(p.id);
    expect((await ingest('/ingest/stripe', { bearer: p.ingestKey })).status).toBe(403);
    expect((await ingest(`/ingest/stripe?key=${p.ingestKey}`, {})).status).toBe(403);
    expect(await countOf(p.id)).toBe(before);
  });

  it('treats an empty X-Account-Slug as no header', async () => {
    const before = await countOf(a.id);
    const ok = await ingestWith('/ingest/stripe', { 'x-account-slug': '', authorization: `Bearer ${a.ingestKey}` });
    expect(ok.status).toBe(202);
    expect(await countOf(a.id)).toBe(before + 1);

    // With no key it is a 401, not a 404 for an unknown account called ''.
    const none = await ingestWith('/ingest/stripe', { 'x-account-slug': '' });
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'invalid or missing API key' });
    expect(await countOf(a.id)).toBe(before + 1);
  });

  it('takes the bearer key over ?key= when both are sent', async () => {
    const [beforeA, beforeB] = [await countOf(a.id), await countOf(b.id)];
    const res = await ingest(`/ingest/stripe?key=${b.ingestKey}`, { bearer: a.ingestKey });
    expect(res.status).toBe(202);
    expect(await countOf(a.id)).toBe(beforeA + 1);
    expect(await countOf(b.id)).toBe(beforeB);
  });

  it('falls through to ?key= when Authorization is not a usable Bearer', async () => {
    // This is how extractKey already behaved before the key could name the account, and this change
    // leaves it alone: a header that is not `Bearer <token>` is ignored, and the query key is used.
    for (const authorization of ['Basic xyz', 'Bearer']) {
      const before = await countOf(a.id);
      const res = await ingestWith(`/ingest/stripe?key=${a.ingestKey}`, { authorization });
      expect(res.status).toBe(202);
      expect(await countOf(a.id)).toBe(before + 1);
    }
  });

  it('answers 401 before 403: a revoked key on a disabled account is 401', async () => {
    const d = await newAccount('d');
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [d.id]);
    const revoked = await revokedKey(d.id);
    const before = await countOf(d.id);
    expect((await ingest('/ingest/stripe', { bearer: revoked })).status).toBe(401);
    expect((await ingest(`/ingest/stripe?key=${revoked}`, {})).status).toBe(401);
    // The live key on the same account is the 403 case.
    expect((await ingest('/ingest/stripe', { bearer: d.ingestKey })).status).toBe(403);
    expect(await countOf(d.id)).toBe(before);
  });

  it('answers 403 and stores nothing for a disabled account\'s ?key=', async () => {
    const e = await newAccount('e');
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [e.id]);
    const before = await countOf(e.id);
    expect((await ingest(`/ingest/stripe?key=${e.ingestKey}`, {})).status).toBe(403);
    expect(await countOf(e.id)).toBe(before);
  });

  it('uses the first ?key= when it is repeated, and stores neither key', async () => {
    const [beforeA, beforeB] = [await countOf(a.id), await countOf(b.id)];
    const res = await ingest(`/ingest/stripe?key=${a.ingestKey}&key=${b.ingestKey}&x=1`, {});
    expect(res.status).toBe(202);
    expect(await countOf(b.id)).toBe(beforeB);
    const events = (await eventsOf(a.id)).slice(beforeA);
    expect(events).toHaveLength(1);
    expect(events[0]!.request.query).toBe('x=1');
    const stored = JSON.stringify(events[0]);
    expect(stored).not.toContain(a.ingestKey);
    expect(stored).not.toContain(b.ingestKey);
  });

  it('answers 401 for an empty ?key= with no slug and no header', async () => {
    await expectNothingStored(() => ingest('/ingest/stripe?key=', {}), 401);
  });

  describe('/tables', () => {
    it('lets a read key alone read only its own account\'s rows', async () => {
      for (const [acct, rowId] of [[a, 'ship-a'], [b, 'ship-b']] as const) {
        const res = await tables({ bearer: acct.readKey });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { rows: { id: string }[] };
        expect(body.rows.map((r) => r.id)).toEqual([rowId]);
      }
    });

    it('answers 401 for no key', async () => {
      const res = await tables({});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid or missing API key' });
    });

    it('answers 401 for a revoked read key', async () => {
      const revoked = await revokedKey(a.id, 'read');
      expect((await tables({ bearer: revoked })).status).toBe(401);
    });
  });
});

describe('with X-Account-Slug, behavior is unchanged', () => {
  it('answers 401 for a slug of account A with a key of account B', async () => {
    await expectNothingStored(() => ingest('/ingest/x', { slug: a.slug, bearer: b.ingestKey }), 401);
  });

  it('answers 404 for an unknown slug', async () => {
    await expectNothingStored(() => ingest('/ingest/x', { slug: 'no-such-acct', bearer: a.ingestKey }), 404);
  });

  it('uses the slug\'s account when the key matches', async () => {
    const before = (await eventsOf(a.id)).length;
    expect((await ingest('/ingest/x', { slug: a.slug, bearer: a.ingestKey })).status).toBe(202);
    expect((await eventsOf(a.id)).length).toBe(before + 1);
  });
});

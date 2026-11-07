import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateAdapter,
  createAdapter,
  loadSamples,
  markValidated,
  validateAdapter,
  validateAndActivate,
  type AdapterOp,
  type AdapterRow,
} from '../src/adapters/index.js';
import { loadConfig } from '../src/config.js';
import type { StorageBackend } from '../src/contracts/index.js';
import { createApp, MAX_BODY_BYTES } from '../src/http/app.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { SandboxUnavailableError } from '../src/sandbox/index.js';
import { generateApiKey, hashApiKey } from '../src/secrets.js';

// These spawn many sandbox processes, so a loaded machine mustn't turn a slow run into a failure.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const GATE = { limits: { timeoutMs: 15_000 } };

const pool = new pg.Pool({ connectionString: loadConfig().appDatabaseUrl });

const accountId = randomUUID();
const otherAccountId = randomUUID();
const storeId = randomUUID();
const TOKEN = 'internal-test-token';
const BEARER = `Bearer ${TOKEN}`;
const config = loadConfig();
const routes = createApp({ appDb: pool, backend: {} as StorageBackend, config: { ...config, internalApiToken: TOKEN }, gate: GATE });
/** The routes as an operator calls them. The auth tests below call `routes` directly. */
const app = {
  request: (path: string, init: RequestInit = {}) =>
    routes.request(path, { ...init, headers: { authorization: BEARER, ...(init.headers as Record<string, string>) } }),
};

const BODY = { id: 5, email: 'ada@example.com' };
const SHAPE = fingerprint(BODY);
const V1 = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email }] }; }`;
const V2 = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email, copy: p.data.email }] }; }`;
const DROPS_EMAIL = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id) }] }; }`;

async function insertEvent(
  body: unknown,
  { source = '', op = 'write', account = accountId, shape }: { source?: string; op?: AdapterOp; account?: string; shape?: string | null } = {},
): Promise<string> {
  const text = body === null ? '' : JSON.stringify(body);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO events (account_id, body, source, op, fingerprint, request)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      account,
      Buffer.from(text),
      source,
      op,
      shape === undefined ? fingerprint(body) : shape,
      { method: op === 'delete' ? 'DELETE' : 'POST', path: '/ingest', query: '', headers: {} },
    ],
  );
  return result.rows[0]!.id;
}

async function quarantine(eventId: string, reason = 'unknown_fingerprint', account = accountId): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO quarantine (event_id, account_id, reason, detail) VALUES ($1, $2, $3, 'why') RETURNING id`,
    [eventId, account, reason],
  );
  return result.rows[0]!.id;
}

async function quarantined(body: unknown = BODY, options: Parameters<typeof insertEvent>[1] = {}): Promise<string> {
  const id = await insertEvent(body, options);
  await quarantine(id);
  return id;
}

function newAdapter(code: string, overrides: Partial<Parameters<typeof createAdapter>[1]> = {}) {
  return { account_id: accountId, source: '', op: 'write' as const, fingerprint: SHAPE, opaque_paths: [], code, ...overrides };
}

async function stored(code: string, overrides: Parameters<typeof newAdapter>[1] = {}): Promise<AdapterRow> {
  const adapter = await createAdapter(pool, newAdapter(code, overrides));
  if (!adapter) throw new Error('No account');
  return adapter;
}

async function row(id: string): Promise<AdapterRow> {
  return (await pool.query<AdapterRow>('SELECT * FROM adapters WHERE id = $1', [id])).rows[0]!;
}

async function replayJobs(adapterId: string) {
  const result = await pool.query<{ kind: string; rerun_requested: boolean; account_id: string }>(
    'SELECT kind, rerun_requested, account_id FROM queue WHERE adapter_id = $1',
    [adapterId],
  );
  return result.rows;
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function clear(): Promise<void> {
  for (const account of [accountId, otherAccountId]) {
    await pool.query('DELETE FROM queue WHERE account_id = $1', [account]);
    await pool.query('DELETE FROM quarantine WHERE account_id = $1', [account]);
    await pool.query('DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = $1)', [account]);
    await pool.query('DELETE FROM adapters WHERE account_id = $1', [account]);
    await pool.query('DELETE FROM events WHERE account_id = $1', [account]);
  }
  await pool.query('DELETE FROM data_columns WHERE store_id = $1', [storeId]);
  await pool.query(`UPDATE account_stores SET status = 'active' WHERE id = $1`, [storeId]);
}

beforeAll(async () => {
  for (const account of [accountId, otherAccountId]) {
    await pool.query('INSERT INTO accounts (id, slug) VALUES ($1, $2)', [account, `adapters-${account}`]);
  }
  await pool.query(
    `INSERT INTO account_stores (id, account_id, generation, backend, connection, namespace, status)
     VALUES ($1, $2, 1, 'fake', '{}', 'adapters_test', 'active')`,
    [storeId, accountId],
  );
});

beforeEach(clear);

afterAll(async () => {
  await clear();
  await pool.query('DELETE FROM account_stores WHERE id = $1', [storeId]);
  await pool.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountId, otherAccountId]]);
  await pool.end();
});

describe('POST /adapters', () => {
  const body = () => ({ account_id: accountId, op: 'write', fingerprint: SHAPE, code: V1 });

  it('creates an inactive, unvalidated first version with defaults', async () => {
    const response = await post('/adapters', body());
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      account_id: accountId,
      source: '',
      op: 'write',
      fingerprint: SHAPE,
      opaque_paths: [],
      version: 1,
      code: V1,
      active: false,
      validated_at: null,
      superseded_at: null,
    });
  });

  it('numbers versions per shape', async () => {
    const version = async (overrides: object) => ((await (await post('/adapters', { ...body(), ...overrides })).json()) as AdapterRow).version;
    expect(await version({})).toBe(1);
    expect(await version({})).toBe(2);
    expect(await version({ op: 'delete' })).toBe(1);
    expect(await version({ source: 'users' })).toBe(1);
  });

  it('gives concurrent creates distinct versions', async () => {
    const created = await Promise.all(Array.from({ length: 4 }, () => createAdapter(pool, newAdapter(V1))));
    expect(created.map((adapter) => adapter?.version).sort()).toEqual([1, 2, 3, 4]);
  });

  it('stores opaque paths', async () => {
    const response = await post('/adapters', { ...body(), source: 'users', opaque_paths: ['metadata'] });
    expect(await response.json()).toMatchObject({ source: 'users', opaque_paths: ['metadata'] });
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', '[1]'],
    ['no account', { op: 'write', fingerprint: SHAPE, code: 'x' }],
    ['a bad account', { account_id: 'x', op: 'write', fingerprint: SHAPE, code: 'x' }],
    ['a bad op', { account_id: accountId, op: 'read', fingerprint: SHAPE, code: 'x' }],
    ['a bad fingerprint', { account_id: accountId, op: 'write', fingerprint: 'XYZ', code: 'x' }],
    ['no code', { account_id: accountId, op: 'write', fingerprint: SHAPE }],
    ['blank code', { account_id: accountId, op: 'write', fingerprint: SHAPE, code: '  ' }],
    ['a NUL in code', { account_id: accountId, op: 'write', fingerprint: SHAPE, code: 'a\0' }],
    ['a long source', { account_id: accountId, op: 'write', fingerprint: SHAPE, code: 'x', source: 'a'.repeat(256) }],
    ['bad opaque paths', { account_id: accountId, op: 'write', fingerprint: SHAPE, code: 'x', opaque_paths: 'metadata' }],
    ['a root opaque path', { account_id: accountId, op: 'write', fingerprint: SHAPE, code: 'x', opaque_paths: ['[]'] }],
  ])('rejects %s', async (_name, invalid) => {
    expect((await post('/adapters', invalid)).status).toBe(400);
  });

  it('returns 404 for an account that does not exist', async () => {
    expect((await post('/adapters', { ...body(), account_id: randomUUID() })).status).toBe(404);
  });

  it('returns 413 for an oversized body', async () => {
    const response = await post('/adapters', { ...body(), code: 'x'.repeat(MAX_BODY_BYTES + 1) }, {
      'content-length': String(MAX_BODY_BYTES + 200),
    });
    expect(response.status).toBe(413);
  });
});

describe('POST /adapters/:id/test', () => {
  it('reports the output and schema changes, marks it validated, and writes nothing else', async () => {
    const eventId = await quarantined();
    const adapter = await stored(V1);
    const response = await post(`/adapters/${adapter.id}/test`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; samples: { event_id: string; output: unknown; schema_changes: unknown[] }[] };
    expect(result.ok).toBe(true);
    expect(result.samples[0]).toMatchObject({
      event_id: eventId,
      output: { table: 'user', rows: [{ id: '5', email: 'ada@example.com' }] },
    });
    expect(result.samples[0]?.schema_changes).toContainEqual({ kind: 'create_table', table: 'user' });

    const after = await row(adapter.id);
    expect(after.validated_at).not.toBeNull();
    expect(after.active).toBe(false);
    expect(await replayJobs(adapter.id)).toEqual([]);
    const columns = await pool.query('SELECT 1 FROM data_columns WHERE store_id = $1', [storeId]);
    expect(columns.rowCount).toBe(0);
  });

  it('reports a failure in full and does not mark it validated', async () => {
    const eventId = await quarantined();
    const adapter = await stored(DROPS_EMAIL);
    const response = await post(`/adapters/${adapter.id}/test`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; failures: unknown[] };
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ code: 'dropped_field', event_id: eventId })]);
    expect((await row(adapter.id)).validated_at).toBeNull();
  });

  it('reports a type conflict with data_columns', async () => {
    await quarantined();
    await pool.query(
      `INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, 'user', 'email', 'number')`,
      [storeId],
    );
    const adapter = await stored(V1);
    const result = (await (await post(`/adapters/${adapter.id}/test`)).json()) as { failures: { code: string; detail: string }[] };
    expect(result.failures.map((failure) => failure.code)).toEqual(['type_conflict']);
  });

  it('ignores a retired store', async () => {
    await quarantined();
    await pool.query(
      `INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, 'user', 'email', 'number')`,
      [storeId],
    );
    await pool.query(`UPDATE account_stores SET status = 'retired' WHERE id = $1`, [storeId]);
    const adapter = await stored(V1);
    expect(((await (await post(`/adapters/${adapter.id}/test`)).json()) as { ok: boolean }).ok).toBe(true);
  });

  it('fails with no_samples when nothing matches', async () => {
    const adapter = await stored(V1);
    const result = (await (await post(`/adapters/${adapter.id}/test`)).json()) as { ok: boolean; failures: { code: string }[] };
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.code).toBe('no_samples');
    expect((await row(adapter.id)).validated_at).toBeNull();
  });

  it.each([randomUUID(), 'not-a-uuid'])('returns 404 for the unknown id %s', async (id) => {
    expect((await post(`/adapters/${id}/test`)).status).toBe(404);
  });
});

describe('choosing samples', () => {
  const draft = (overrides = {}) => newAdapter(V1, overrides);

  it('uses open quarantine rows of the same account, source, op and shape', async () => {
    const match = await quarantined();
    await quarantined(BODY, { source: 'other' });
    await quarantined(BODY, { op: 'delete' });
    await quarantined({ different: true });
    const other = await insertEvent(BODY, { account: otherAccountId });
    await quarantine(other, 'unknown_fingerprint', otherAccountId);

    const samples = await loadSamples(pool, draft());
    expect(samples.map((sample) => sample.eventId)).toEqual([match]);
  });

  it('prefers open rows over released ones and other events', async () => {
    const open = await quarantined();
    const released = await quarantined();
    await pool.query('UPDATE quarantine SET released_at = now() WHERE event_id = $1', [released]);
    await insertEvent(BODY);
    expect((await loadSamples(pool, draft())).map((sample) => sample.eventId)).toEqual([open]);
  });

  it('falls back to the event log when no rows are open', async () => {
    const processed = await insertEvent(BODY);
    expect((await loadSamples(pool, draft())).map((sample) => sample.eventId)).toEqual([processed]);
  });

  it('skips malformed rows', async () => {
    const eventId = await insertEvent(BODY);
    await quarantine(eventId, 'malformed');
    const fallback = await loadSamples(pool, draft());
    expect(fallback.map((sample) => sample.eventId)).toEqual([eventId]);
    const other = await quarantined();
    expect((await loadSamples(pool, draft())).map((sample) => sample.eventId)).toEqual([other]);
  });

  it('keeps the exact bytes and the request', async () => {
    const eventId = await insertEvent(BODY);
    await pool.query('UPDATE events SET body = $1 WHERE id = $2', [Buffer.from('{ "id":5, "email":"a" }'), eventId]);
    const [sample] = await loadSamples(pool, draft());
    expect(sample).toEqual({
      eventId,
      body: '{ "id":5, "email":"a" }',
      request: { method: 'POST', path: '/ingest', query: '', headers: {} },
    });
  });

  it('treats an empty body as no body', async () => {
    const eventId = await insertEvent(null, { op: 'delete' });
    const [sample] = await loadSamples(pool, draft({ op: 'delete', fingerprint: fingerprint(null) }));
    expect(sample).toMatchObject({ eventId, body: null });
  });

  it('honours the limit, and takes turns across shapes', async () => {
    const opaquePaths = ['metadata'];
    const collapsed = fingerprint({ metadata: { a: 1 } }, { opaquePaths });
    const busy = [await quarantined({ metadata: { a: 1 } }), await quarantined({ metadata: { a: 2 } })];
    const rare = await quarantined({ metadata: { b: 'x' } });
    const samples = await loadSamples(pool, draft({ opaque_paths: opaquePaths, fingerprint: collapsed }), 2);
    expect(samples.map((sample) => sample.eventId).sort()).toEqual([busy[1], rare].sort());
  });

  it('matches events through opaque paths, but not other shapes', async () => {
    const opaquePaths = ['metadata'];
    const collapsed = fingerprint({ metadata: { a: 1 } }, { opaquePaths });
    const a = await quarantined({ metadata: { a: 1 } });
    const b = await quarantined({ metadata: { b: 'x', c: true } });
    await quarantined({ metadata: { a: 1 }, extra: 1 });
    const samples = await loadSamples(pool, draft({ opaque_paths: opaquePaths, fingerprint: collapsed }));
    expect(samples.map((sample) => sample.eventId).sort()).toEqual([a, b].sort());
  });

  it('includes fingerprints the adapter was validated against', async () => {
    const first = await quarantined();
    const further = await quarantined({ id: 1, email: 'b', extra: 'x' });
    const adapter = await stored(V1);
    await pool.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [
      adapter.id,
      fingerprint({ id: 1, email: 'b', extra: 'x' }),
    ]);
    const samples = await loadSamples(pool, adapter);
    expect(samples.map((sample) => sample.eventId).sort()).toEqual([first, further].sort());
  });
});

describe('activation', () => {
  it('activates, sets validated_at, and enqueues a replay', async () => {
    await quarantined();
    const adapter = await stored(V1);
    const response = await post(`/adapters/${adapter.id}/activate`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: adapter.id, active: true, superseded_at: null });
    const after = await row(adapter.id);
    expect(after.active).toBe(true);
    expect(after.validated_at).not.toBeNull();
    expect(await replayJobs(adapter.id)).toEqual([{ kind: 'replay', rerun_requested: false, account_id: accountId }]);
  });

  it('refuses an adapter that fails the gate, and changes nothing', async () => {
    await quarantined();
    const adapter = await stored(DROPS_EMAIL);
    const response = await post(`/adapters/${adapter.id}/activate`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, failures: [{ code: 'dropped_field' }] });
    const after = await row(adapter.id);
    expect(after.active).toBe(false);
    expect(after.validated_at).toBeNull();
    expect(await replayJobs(adapter.id)).toEqual([]);
  });

  it('runs the gate again on an adapter already validated, leaving the live version alone', async () => {
    await quarantined();
    const v1 = await stored(V1);
    expect((await validateAndActivate(pool, v1.id, GATE)).status).toBe('activated');

    // It looks validated, but it stops writing a column the live version writes.
    const v2 = await stored(`function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), renamed: p.data.email }] }; }`);
    await markValidated(pool, v2.id);
    const response = await post(`/adapters/${v2.id}/activate`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ failures: [{ code: 'dropped_column' }] });
    expect((await row(v1.id)).active).toBe(true);
    expect((await row(v2.id)).active).toBe(false);
  });

  it('deactivates the old version and supersedes every other version of the shape', async () => {
    await quarantined();
    const v1 = await stored(V1);
    await validateAndActivate(pool, v1.id, GATE);
    const draft = await stored(DROPS_EMAIL);
    const awaiting = await stored(V2);
    await markValidated(pool, awaiting.id);
    const v4 = await stored(V2);
    const other = await stored(V1, { source: 'other' });

    expect((await post(`/adapters/${v4.id}/activate`)).status).toBe(200);

    expect(await row(v1.id)).toMatchObject({ active: false, superseded_at: expect.any(Date) });
    expect(await row(draft.id)).toMatchObject({ active: false, superseded_at: expect.any(Date) });
    expect(await row(awaiting.id)).toMatchObject({ active: false, superseded_at: expect.any(Date) });
    expect(await row(v4.id)).toMatchObject({ active: true, superseded_at: null });
    expect(await row(other.id)).toMatchObject({ active: false, superseded_at: null });
  });

  it('keeps the first superseded_at, and clears it on a version activated again', async () => {
    await quarantined();
    const v1 = await stored(V1);
    await validateAndActivate(pool, v1.id, GATE);
    const v2 = await stored(V1);
    await validateAndActivate(pool, v2.id, GATE);
    const first = (await row(v1.id)).superseded_at;
    const v3 = await stored(V1);
    await validateAndActivate(pool, v3.id, GATE);
    expect((await row(v1.id)).superseded_at).toEqual(first);

    expect((await validateAndActivate(pool, v1.id, GATE)).status).toBe('activated');
    expect(await row(v1.id)).toMatchObject({ active: true, superseded_at: null });
    expect(await row(v3.id)).toMatchObject({ active: false, superseded_at: expect.any(Date) });
  });

  it('asks a queued replay to run again, rather than adding one', async () => {
    await quarantined();
    const adapter = await stored(V1);
    await validateAndActivate(pool, adapter.id, GATE);
    await validateAndActivate(pool, adapter.id, GATE);
    expect(await replayJobs(adapter.id)).toEqual([{ kind: 'replay', rerun_requested: true, account_id: accountId }]);
  });

  it('refuses an adapter that never passed the gate', async () => {
    const adapter = await stored(V1);
    expect(await activateAdapter(pool, adapter.id, { replacing: null })).toEqual({ status: 'not_validated' });
    expect((await row(adapter.id)).active).toBe(false);
  });

  it('refuses when another version went live after the gate ran', async () => {
    await quarantined();
    const v1 = await stored(V1);
    const v2 = await stored(V1);
    await markValidated(pool, v1.id);
    await markValidated(pool, v2.id);
    const validatedAgainstNothing = { replacing: null };
    expect((await activateAdapter(pool, v1.id, validatedAgainstNothing)).status).toBe('activated');
    expect(await activateAdapter(pool, v2.id, validatedAgainstNothing)).toEqual({ status: 'stale' });
    expect((await row(v2.id)).active).toBe(false);
    expect((await row(v1.id)).active).toBe(true);
  });

  it('leaves exactly one active version under concurrent activations', async () => {
    await quarantined();
    const versions = await Promise.all([stored(V1), stored(V1), stored(V1), stored(V1)]);
    for (const version of versions) await markValidated(pool, version.id);
    const results = await Promise.all(versions.map((version) => activateAdapter(pool, version.id, { replacing: null })));
    expect(results.filter((result) => result.status === 'activated')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'stale')).toHaveLength(3);

    const rows = await Promise.all(versions.map((version) => row(version.id)));
    expect(rows.filter((adapter) => adapter.active)).toHaveLength(1);
    expect(rows.filter((adapter) => adapter.superseded_at !== null)).toHaveLength(3);
  });

  it('rolls back the whole activation if the replay cannot be enqueued', async () => {
    await quarantined();
    const v1 = await stored(V1);
    await validateAndActivate(pool, v1.id, GATE);
    const v2 = await stored(V1);
    await markValidated(pool, v2.id);

    // A pool of one always hands out this client, and ending the pool discards the patch.
    const failingPool = new pg.Pool({ connectionString: loadConfig().appDatabaseUrl, max: 1 });
    const client = await failingPool.connect();
    const realQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    client.query = ((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('INSERT INTO queue')) return Promise.reject(new Error('queue down'));
      return realQuery(...args);
    }) as typeof client.query;
    client.release();

    await expect(activateAdapter(failingPool, v2.id, { replacing: v1.id })).rejects.toThrow('queue down');
    await failingPool.end();

    expect(await row(v1.id)).toMatchObject({ active: true, superseded_at: null });
    expect(await row(v2.id)).toMatchObject({ active: false, superseded_at: null });
    expect(await replayJobs(v2.id)).toEqual([]);
  });

  it('returns 404 for an unknown id', async () => {
    expect((await post(`/adapters/${randomUUID()}/activate`)).status).toBe(404);
    expect((await post('/adapters/x/activate')).status).toBe(404);
  });
});

describe('the generator using these functions', () => {
  it('validates a stored adapter without activating it', async () => {
    await quarantined();
    const adapter = await stored(V1);
    const result = await validateAdapter(pool, adapter.id, GATE);
    expect(result?.gate.ok).toBe(true);
    expect(await row(adapter.id)).toMatchObject({ active: false, validated_at: expect.any(Date) });
    expect(await validateAdapter(pool, randomUUID())).toBeNull();
  });
});

describe('POST /adapters/:id/replay', () => {
  it('enqueues a replay on an active adapter', async () => {
    await quarantined();
    const adapter = await stored(V1);
    await validateAndActivate(pool, adapter.id, GATE);
    await pool.query('DELETE FROM queue WHERE adapter_id = $1', [adapter.id]);

    const response = await post(`/adapters/${adapter.id}/replay`);
    expect(response.status).toBe(202);
    expect(await replayJobs(adapter.id)).toEqual([{ kind: 'replay', rerun_requested: false, account_id: accountId }]);
  });

  it('sets rerun_requested when a replay is already queued, and keeps run_at', async () => {
    await quarantined();
    const adapter = await stored(V1);
    await validateAndActivate(pool, adapter.id, GATE);
    await pool.query(`UPDATE queue SET run_at = now() + interval '1 hour' WHERE adapter_id = $1`, [adapter.id]);
    const before = await pool.query('SELECT run_at FROM queue WHERE adapter_id = $1', [adapter.id]);

    expect((await post(`/adapters/${adapter.id}/replay`)).status).toBe(202);

    expect(await replayJobs(adapter.id)).toEqual([{ kind: 'replay', rerun_requested: true, account_id: accountId }]);
    const after = await pool.query('SELECT run_at FROM queue WHERE adapter_id = $1', [adapter.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it('refuses an inactive adapter', async () => {
    const adapter = await stored(V1);
    expect((await post(`/adapters/${adapter.id}/replay`)).status).toBe(409);
    expect(await replayJobs(adapter.id)).toEqual([]);
  });

  it('returns 404 for an unknown id', async () => {
    expect((await post(`/adapters/${randomUUID()}/replay`)).status).toBe(404);
    expect((await post('/adapters/x/replay')).status).toBe(404);
  });
});

describe('GET /quarantine', () => {
  const list = async (query: string) => {
    const response = await app.request(`/quarantine?${query}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { rows: Record<string, unknown>[] }).rows;
  };

  it('lists open rows with their payload and event', async () => {
    const eventId = await quarantined();
    const [entry] = await list(`account_id=${accountId}`);
    expect(entry).toMatchObject({
      event_id: eventId,
      source: '',
      op: 'write',
      fingerprint: SHAPE,
      reason: 'unknown_fingerprint',
      detail: 'why',
      body_bytes: JSON.stringify(BODY).length,
      request: { method: 'POST' },
    });
  });

  it('leaves out released rows and other accounts', async () => {
    const released = await quarantined();
    await pool.query('UPDATE quarantine SET released_at = now() WHERE event_id = $1', [released]);
    const other = await insertEvent(BODY, { account: otherAccountId });
    await quarantine(other, 'unknown_fingerprint', otherAccountId);
    expect(await list(`account_id=${accountId}`)).toEqual([]);
  });

  it('filters by source, op, fingerprint and reason', async () => {
    const a = await quarantined(BODY, { source: 'users' });
    const b = await quarantined(BODY, { op: 'delete' });
    const c = await quarantined({ other: 1 });
    const d = await insertEvent(BODY);
    await quarantine(d, 'write_error');
    const ids = async (query: string) => (await list(`account_id=${accountId}&${query}`)).map((entry) => entry.event_id);

    expect(await ids('source=users')).toEqual([a]);
    expect((await ids('source=')).sort()).toEqual([b, c, d].sort());
    expect(await ids('op=delete')).toEqual([b]);
    expect(await ids(`fingerprint=${fingerprint({ other: 1 })}`)).toEqual([c]);
    expect(await ids('reason=write_error')).toEqual([d]);
    expect(await ids('source=users&op=delete')).toEqual([]);
  });

  it('pages', async () => {
    await quarantined();
    await quarantined();
    await quarantined();
    expect(await list(`account_id=${accountId}&limit=2`)).toHaveLength(2);
    expect(await list(`account_id=${accountId}&limit=2&offset=2`)).toHaveLength(1);
  });

  it.each([
    ['no account', ''],
    ['a bad account', 'account_id=x'],
    ['a bad op', 'op=read'],
    ['a bad reason', 'reason=nope'],
    ['a NUL', 'source=%00'],
    ['a zero limit', 'limit=0'],
    ['a huge limit', 'limit=1001'],
    ['a bad offset', 'offset=-1'],
  ])('rejects %s', async (name, query) => {
    const account = name.includes('account') ? '' : `account_id=${accountId}&`;
    expect((await app.request(`/quarantine?${account}${query}`)).status).toBe(400);
  });
});

const serverApp = (token: string | undefined, appDb: pg.Pool = pool) =>
  createApp({ appDb, backend: {} as StorageBackend, config: { ...config, internalApiToken: token } });

describe('the internal token', () => {
  const ID = randomUUID();
  const ROUTES: [string, string, string?][] = [
    ['POST', '/adapters', JSON.stringify({ account_id: accountId, op: 'write', fingerprint: SHAPE, code: V1 })],
    ['POST', `/adapters/${ID}/test`],
    ['POST', `/adapters/${ID}/activate`],
    ['POST', `/adapters/${ID}/replay`],
    ['GET', `/quarantine?account_id=${accountId}`],
  ];

  async function expectRefused(target: { request(path: string, init: RequestInit): Response | Promise<Response> }, headers: Record<string, string>, suffix = '') {
    for (const [method, path, body] of ROUTES) {
      const url = path + (suffix && (path.includes('?') ? `&${suffix}` : `?${suffix}`));
      const response = await target.request(url, { method, headers, ...(body ? { body } : {}) });
      expect([path, response.status]).toEqual([path, 401]);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    const created = await pool.query('SELECT 1 FROM adapters WHERE account_id = $1', [accountId]);
    expect(created.rowCount).toBe(0);
  }

  it('lets the correct token through on every route', async () => {
    for (const [method, path, body] of ROUTES) {
      const headers = { authorization: BEARER, ...(body ? { 'content-type': 'application/json' } : {}) };
      const response = await routes.request(path, { method, headers, ...(body ? { body } : {}) });
      expect([path, response.status]).toEqual([path, path === '/adapters' ? 201 : path.startsWith('/quarantine') ? 200 : 404]);
    }
  });

  it('accepts any case of the scheme', async () => {
    const response = await routes.request(`/quarantine?account_id=${accountId}`, { headers: { authorization: `bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
  });

  it('refuses a missing token', () => expectRefused(routes, {}));

  it.each([
    ['text', 'text/plain'],
    ['a form', 'application/x-www-form-urlencoded'],
    ['a lookalike', 'application/jsonp'],
  ])('refuses a body sent as %s, as a browser could from any page', async (_name, type) => {
    const response = await routes.request('/adapters', {
      method: 'POST',
      headers: { authorization: BEARER, 'content-type': type },
      body: JSON.stringify({ account_id: accountId, op: 'write', fingerprint: SHAPE, code: V1 }),
    });
    expect(response.status).toBe(415);
    const created = await pool.query('SELECT 1 FROM adapters WHERE account_id = $1', [accountId]);
    expect(created.rowCount).toBe(0);
  });

  it('accepts JSON with a charset, and a POST with no body and no type', async () => {
    const withCharset = await routes.request('/adapters', {
      method: 'POST',
      headers: { authorization: BEARER, 'content-type': 'Application/JSON; charset=utf-8' },
      body: JSON.stringify({ account_id: accountId, op: 'write', fingerprint: SHAPE, code: V1 }),
    });
    expect(withCharset.status).toBe(201);
    const noBody = await routes.request(`/adapters/${randomUUID()}/replay`, { method: 'POST', headers: { authorization: BEARER } });
    expect(noBody.status).toBe(404);
  });

  it.each([
    ['a wrong token', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['the token with more added', `Bearer ${TOKEN}x`],
    ['the wrong scheme', `Basic ${TOKEN}`],
    ['the token with no scheme', TOKEN],
    ['an empty bearer', 'Bearer '],
    ['extra parts', `Bearer ${TOKEN} extra`],
  ])('refuses %s', (_name, authorization) => expectRefused(routes, { authorization }));

  it('refuses the token in the query string, which only /ingest allows for keys', () =>
    expectRefused(routes, {}, `key=${TOKEN}`));

  it('refuses a real customer API key', async () => {
    const key = generateApiKey();
    await pool.query('INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2)', [accountId, hashApiKey(key)]);
    try {
      await expectRefused(routes, { authorization: `Bearer ${key}` });
    } finally {
      await pool.query('DELETE FROM api_keys WHERE account_id = $1', [accountId]);
    }
  });

  describe.each([
    ['unset', undefined],
    ['empty', ''],
  ])('when it is %s', (_name, token) => {
    const closed = createApp({ appDb: pool, backend: {} as StorageBackend, config: { ...config, internalApiToken: token } });

    it.each([
      ['no header', {}],
      ['a guess', { authorization: BEARER }],
      ['the word undefined', { authorization: 'Bearer undefined' }],
      ['an empty bearer', { authorization: 'Bearer ' }],
    ])('refuses %s', (_guess, headers: Record<string, string>) => expectRefused(closed, headers));

    it('refuses through the server too', () => expectRefused(serverApp(token), { authorization: BEARER }));
  });

  it('reads the token from INTERNAL_API_TOKEN, treating empty as unset', () => {
    vi.stubEnv('INTERNAL_API_TOKEN', 'from-env');
    expect(loadConfig().internalApiToken).toBe('from-env');
    vi.stubEnv('INTERNAL_API_TOKEN', '');
    expect(loadConfig().internalApiToken).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe('mounted on the server', () => {
  const server = serverApp(TOKEN);
  const operator = { authorization: BEARER };

  it('serves every route', async () => {
    const adapter = await stored(V1);
    expect((await server.request(`/adapters/${adapter.id}/test`, { method: 'POST', headers: operator })).status).toBe(200);
    expect((await server.request(`/quarantine?account_id=${accountId}`, { headers: operator })).status).toBe(200);
    expect((await server.request(`/adapters/${adapter.id}/replay`, { method: 'POST', headers: operator })).status).toBe(409);
    const created = await server.request('/adapters', {
      method: 'POST',
      headers: { ...operator, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: accountId, op: 'write', fingerprint: SHAPE, code: V1 }),
    });
    expect(created.status).toBe(201);
  });

  it('requires the token', async () => {
    expect((await server.request(`/quarantine?account_id=${accountId}`)).status).toBe(401);
  });

  it('does not put the token on the other routes', async () => {
    const health = await server.request('/healthz');
    expect(health.status).toBe(200);
    const ingest = await server.request('/ingest/users', { method: 'POST', body: '{}' });
    expect(await ingest.json()).toEqual({ error: 'unknown account' });
  });

  it('refuses a dot segment that would reach these routes from /ingest', async () => {
    const response = await server.fetch(
      new Request('http://x/quarantine'),
      { incoming: { url: `/ingest/../quarantine?account_id=${accountId}` } } as never,
    );
    expect(response.status).toBe(404);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'via', 'x-account-slug'])(
    'hides the routes from a request with %s, even with the token',
    async (header) => {
      const adapter = await stored(V1);
      const headers = { ...operator, [header]: 'x' };
      expect((await server.request(`/quarantine?account_id=${accountId}`, { headers })).status).toBe(404);
      expect((await server.request('/adapters', { method: 'POST', headers, body: '{}' })).status).toBe(404);
      for (const action of ['test', 'activate', 'replay']) {
        const response = await server.request(`/adapters/${adapter.id}/${action}`, { method: 'POST', headers });
        expect(response.status).toBe(404);
      }
    },
  );

  it('does not spread the proxy check to the public routes', async () => {
    const response = await server.request('/ingest/users', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.1', 'x-account-slug': 'no-such-account' },
      body: '{}',
    });
    expect(await response.json()).toEqual({ error: 'unknown account' });
  });
});

describe('failures', () => {
  const headers = { authorization: BEARER };

  it('returns 503 when the sandbox cannot run, and changes nothing', async () => {
    await quarantined();
    const adapter = await stored(V1);
    const service = createApp({
      appDb: pool,
      backend: {} as StorageBackend,
      config: { ...config, internalApiToken: TOKEN },
      gate: { run: async () => { throw new SandboxUnavailableError('down'); } },
    });
    const response = await service.request(`/adapters/${adapter.id}/activate`, { method: 'POST', headers });
    expect(response.status).toBe(503);
    expect(await row(adapter.id)).toMatchObject({ active: false, validated_at: null });
  });

  it('reports a database outage the way the server does', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://nobody:secret@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    const response = await serverApp(TOKEN, dead).request(`/quarantine?account_id=${accountId}`, { headers });
    await dead.end();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'database unavailable' });
  });

  it('hides internal errors', async () => {
    const failing = { query: async () => { throw new Error('secret detail'); } } as unknown as pg.Pool;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await serverApp(TOKEN, failing).request(`/quarantine?account_id=${accountId}`, { headers });
    log.mockRestore();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });
});

describe('review findings', () => {
  const RENAMES = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email_address: p.data.email }] }; }`;
  const THROWS_ON_666 = `function adapt(p) {
    if (p.data.id === 666) throw new Error('old bug');
    return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email }] };
  }`;

  async function liveVersion(code: string): Promise<AdapterRow> {
    const adapter = await stored(code);
    await markValidated(pool, adapter.id);
    const result = await activateAdapter(pool, adapter.id, { replacing: null });
    if (result.status !== 'activated') throw new Error(result.status);
    return adapter;
  }

  it('catches a dropped column when the live version throws on every open row', async () => {
    await insertEvent(BODY);
    await quarantined({ id: 666, email: 'b@example.com' });
    await liveVersion(THROWS_ON_666);
    const replacement = await stored(RENAMES);
    const response = await post(`/adapters/${replacement.id}/activate`);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ failures: [{ code: 'dropped_column' }] });
  });

  it('samples both open rows and handled events when replacing a version', async () => {
    const handled = await insertEvent(BODY);
    const open = await quarantined({ id: 666, email: 'b@example.com' });
    const samples = await loadSamples(pool, newAdapter(V1), 10, { includeHandled: true });
    expect(samples.map((sample) => sample.eventId).sort()).toEqual([handled, open].sort());
  });

  it('does not let write_error rows crowd out rows a new adapter must handle', async () => {
    const fixable = await insertEvent(BODY);
    await quarantine(fixable, 'adapter_error');
    const failedWrite = await insertEvent(BODY);
    await quarantine(failedWrite, 'write_error');
    const samples = await loadSamples(pool, newAdapter(V1), 1);
    expect(samples.map((sample) => sample.eventId)).toEqual([fixable]);
  });

  it('counts a write_error event as handled, and can still use it alone', async () => {
    const failedWrite = await insertEvent(BODY);
    await quarantine(failedWrite, 'write_error');
    expect((await loadSamples(pool, newAdapter(V1))).map((sample) => sample.eventId)).toEqual([failedWrite]);
    expect((await loadSamples(pool, newAdapter(V1), 10, { includeHandled: true })).map((sample) => sample.eventId)).toEqual([failedWrite]);
  });

  it('leaves bodies out of the quarantine list, but gives their size', async () => {
    const big = await insertEvent({ blob: 'x'.repeat(70 * 1024) });
    await quarantine(big);
    const response = await app.request(`/quarantine?account_id=${accountId}`);
    const { rows } = (await response.json()) as { rows: Record<string, unknown>[] };
    expect(rows[0]).not.toHaveProperty('body');
    expect(rows[0]?.body_bytes).toBeGreaterThan(70 * 1024);
  });

  it('limits a quarantine page to 200 rows', async () => {
    expect((await app.request(`/quarantine?account_id=${accountId}&limit=200`)).status).toBe(200);
    expect((await app.request(`/quarantine?account_id=${accountId}&limit=201`)).status).toBe(400);
  });
});

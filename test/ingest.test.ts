import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { fingerprint } from '../src/fingerprint/index.js';
import { createApp, MAX_BODY_BYTES } from '../src/http/app.js';
import { DELIVERY_ID_HEADERS, stripKeyParam } from '../src/http/routes/ingest.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

let server: ReturnType<typeof serve>;
let port: number;
const slugs: string[] = [];

interface Account {
  account_id: string;
  slug: string;
  api_key: string;
}

async function createAccount(): Promise<Account> {
  const slug = `ing-${randomBytes(5).toString('hex')}`;
  slugs.push(slug);
  const res = await app.request('/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Account;
}

interface Sent {
  status: number;
  json: Record<string, unknown>;
  allow?: string;
}

/** Sends a real HTTP request, so the path, query and headers reach the app exactly as written. */
function send(
  method: string,
  path: string,
  options: {
    account?: Account;
    slug?: string;
    key?: string | null;
    headers?: string[]; // flat name, value pairs, so repeats are possible
    body?: Buffer | string;
  } = {},
): Promise<Sent> {
  const { account } = options;
  const headers: string[] = [];
  const slug = options.slug ?? account?.slug;
  if (slug) headers.push('X-Account-Slug', slug);
  const key = options.key === undefined ? account?.api_key : options.key;
  if (key) headers.push('Authorization', `Bearer ${key}`);
  headers.push(...(options.headers ?? []));
  // Node adds no body framing to a DELETE, so say how long the body is.
  if (options.body !== undefined) headers.push('Content-Length', String(Buffer.byteLength(options.body)));
  return new Promise((resolve, reject) => {
    const grouped: Record<string, string[]> = {};
    for (let i = 0; i < headers.length; i += 2) (grouped[headers[i]!.toLowerCase()] ??= []).push(headers[i + 1]!);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: grouped }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode!,
          json: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
          allow: res.headers.allow,
        }),
      );
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

interface EventRow {
  id: string;
  body: Buffer;
  source: string;
  op: string;
  fingerprint: string | null;
  idempotency_key: string | null;
  request: { method: string; path: string; query: string; headers: Record<string, string> };
}

async function events(account: Account): Promise<EventRow[]> {
  const { rows } = await appDb.query<EventRow>(
    'SELECT * FROM events WHERE account_id = $1 ORDER BY seq',
    [account.account_id],
  );
  return rows;
}

async function count(table: 'events' | 'queue' | 'quarantine', account: Account): Promise<number> {
  const { rows } = await appDb.query(`SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`, [
    account.account_id,
  ]);
  return rows[0].n;
}

let acct: Account;
beforeAll(async () => {
  server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  acct = await createAccount();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  const admin = new pg.Client({
    host: 'localhost',
    port: config.postgresPort,
    database: 'sw_data',
    user: 'sw_data',
    password: config.dataDbPassword,
  });
  await admin.connect();
  const { rows } = await appDb.query<{ id: string }>('SELECT id FROM accounts WHERE slug = ANY($1)', [
    slugs,
  ]);
  for (const { id } of rows) {
    const namespace = `acct_${id.replaceAll('-', '')}_1`;
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
    for (const table of ['quarantine', 'queue', 'events', 'api_keys', 'account_stores']) {
      await appDb.query(`DELETE FROM ${table} WHERE account_id = $1`, [id]);
    }
    await appDb.query('DELETE FROM accounts WHERE id = $1', [id]);
  }
  await admin.end();
  await appDb.end();
});

describe('POST /ingest', () => {
  it('queues a well-formed event with its queue row', async () => {
    const a = await createAccount();
    const res = await send('POST', '/ingest/customers', { account: a, body: '{"id":1,"name":"x"}' });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: 'queued', event_id: expect.any(String) });
    const [event] = await events(a);
    expect(event!.id).toBe(res.json.event_id);
    expect(event!.fingerprint).toBe(fingerprint({ id: 1, name: 'x' }));
    expect(event!.op).toBe('write');
    const { rows } = await appDb.query(`SELECT kind, event_id FROM queue WHERE account_id = $1`, [
      a.account_id,
    ]);
    expect(rows).toEqual([{ kind: 'ingest', event_id: event!.id }]);
    expect(await count('quarantine', a)).toBe(0);
  });

  it('accepts a top-level array and the ?key= query key', async () => {
    const a = await createAccount();
    const res = await send('PUT', `/ingest/x?key=${a.api_key}`, {
      slug: a.slug,
      key: null,
      body: '[{"a":1}]',
    });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('queued');
  });

  it('stores the exact bytes, including whitespace and Unicode', async () => {
    const a = await createAccount();
    const body = Buffer.from('  {\n\t"naïve" : "日本語 \\u00e9 😀" ,"n":1.50}\r\n  ', 'utf8');
    const res = await send('PATCH', '/ingest/u', { account: a, body });
    expect(res.status).toBe(202);
    const [event] = await events(a);
    expect(Buffer.compare(event!.body, body)).toBe(0);
  });

  it('derives the same source for /ingest, /ingest/customers and /ingest/customers/123', async () => {
    const a = await createAccount();
    await send('POST', '/ingest', { account: a, body: '{}' });
    await send('POST', '/ingest/', { account: a, body: '{}' });
    await send('POST', '/ingest/customers', { account: a, body: '{}' });
    await send('POST', '/ingest/customers/123', { account: a, body: '{}' });
    await send('POST', '/ingest/cust%C3%B6mers/1', { account: a, body: '{}' });
    expect((await events(a)).map((e) => e.source)).toEqual([
      '',
      '',
      'customers',
      'customers',
      'custömers',
    ]);
  });

  it('derives op from the method, and allows an empty DELETE body', async () => {
    const a = await createAccount();
    for (const method of ['POST', 'PUT', 'PATCH']) {
      expect((await send(method, '/ingest/o', { account: a, body: '{"a":1}' })).status).toBe(202);
    }
    expect((await send('DELETE', '/ingest/o', { account: a, body: '{"id":1}' })).status).toBe(202);
    const empty = await send('DELETE', '/ingest/o', { account: a });
    expect(empty.status).toBe(202);
    expect(empty.json.status).toBe('queued');
    const rows = await events(a);
    expect(rows.map((e) => e.op)).toEqual(['write', 'write', 'write', 'delete', 'delete']);
    expect(rows[4]!.fingerprint).toBe(fingerprint(null));
    expect(rows[4]!.body.length).toBe(0);
    expect(await count('queue', a)).toBe(5);
  });

  it('answers 405 with Allow for other methods, before auth', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await send(method, '/ingest/x', { slug: 'nobody', key: null });
      expect(res.status, method).toBe(405);
      expect(res.allow).toBe('POST, PUT, PATCH, DELETE');
    }
    expect((await app.request('/ingest', { method: 'GET' })).status).toBe(405);
  });
});

describe('malformed bodies', () => {
  it.each([
    ['string', '"hello"'],
    ['number', '42'],
    ['boolean', 'true'],
    ['null', 'null'],
  ])('quarantines a %s scalar without queueing', async (_name, body) => {
    const a = await createAccount();
    const res = await send('POST', '/ingest/s', { account: a, body });
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: 'malformed', event_id: expect.any(String) });
    const [event] = await events(a);
    expect(event!.fingerprint).toBeNull();
    const { rows } = await appDb.query(
      `SELECT event_id, reason, detail, store_id FROM quarantine WHERE account_id = $1`,
      [a.account_id],
    );
    expect(rows).toEqual([
      { event_id: event!.id, reason: 'malformed', detail: 'JSON scalar', store_id: null },
    ]);
    expect(await count('queue', a)).toBe(0);
  });

  it('treats an explicit null body as malformed on DELETE too', async () => {
    const a = await createAccount();
    const res = await send('DELETE', '/ingest/s', { account: a, body: 'null' });
    expect(res.json.status).toBe('malformed');
  });

  it('quarantines a body nested too deep', async () => {
    const a = await createAccount();
    const body = '['.repeat(300) + ']'.repeat(300);
    const res = await send('POST', '/ingest/deep', { account: a, body });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('malformed');
    const { rows } = await appDb.query(`SELECT detail FROM quarantine WHERE account_id = $1`, [
      a.account_id,
    ]);
    expect(rows).toEqual([{ detail: 'nesting too deep' }]);
    expect(await count('queue', a)).toBe(0);
  });
});

describe('400 and stores nothing', () => {
  const cases: [string, string, () => { path: string; body?: Buffer | string; headers?: string[]; method?: string }][] = [
    ['invalid JSON', 'json', () => ({ path: '/ingest/x', body: '{"a":' })],
    ['whitespace-only body', 'ws', () => ({ path: '/ingest/x', body: '  ' })],
    ['invalid UTF-8 body', 'utf8', () => ({ path: '/ingest/x', body: Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) })],
    ['UTF-8 BOM body', 'bom', () => ({ path: '/ingest/x', body: Buffer.from('﻿{}') })],
    ['empty POST body', 'empty-post', () => ({ path: '/ingest/x' })],
    ['empty PUT body', 'empty-put', () => ({ path: '/ingest/x', method: 'PUT' })],
    ['empty PATCH body', 'empty-patch', () => ({ path: '/ingest/x', method: 'PATCH' })],
    ['segment over 255 bytes', 'long', () => ({ path: `/ingest/${'a'.repeat(256)}`, body: '{}' })],
    ['multibyte segment over 255 bytes', 'long-mb', () => ({ path: `/ingest/${'%C3%A9'.repeat(128)}`, body: '{}' })],
    ['segment with %00', 'nul', () => ({ path: '/ingest/a%00b', body: '{}' })],
    ['segment with invalid UTF-8', 'bad-seg', () => ({ path: '/ingest/a%FFb', body: '{}' })],
    ['segment with a malformed escape', 'bad-esc', () => ({ path: '/ingest/a%zz', body: '{}' })],
    ['Idempotency-Key over 255 bytes', 'idem', () => ({ path: '/ingest/x', body: '{}', headers: ['Idempotency-Key', 'k'.repeat(256)] })],
    ['delivery header over 255 bytes', 'deliv', () => ({ path: '/ingest/x', body: '{}', headers: ['X-GitHub-Delivery', 'k'.repeat(256)] })],
  ];
  it.each(cases)('%s', async (_name, _id, build) => {
    const a = await createAccount();
    const { path, body, headers, method } = build();
    const res = await send(method ?? 'POST', path, { account: a, body, headers });
    expect(res.status).toBe(400);
    expect(await count('events', a)).toBe(0);
    expect(await count('queue', a)).toBe(0);
    expect(await count('quarantine', a)).toBe(0);
  });

  it('accepts a 255-byte segment and key', async () => {
    const a = await createAccount();
    const res = await send('POST', `/ingest/${'a'.repeat(255)}`, {
      account: a,
      body: '{}',
      headers: ['Idempotency-Key', 'k'.repeat(255)],
    });
    expect(res.status).toBe(202);
  });
});

describe('auth, size and availability statuses', () => {
  it('answers 404 for an unknown account', async () => {
    const res = await send('POST', '/ingest/x', { slug: 'no-such-acct', key: 'sw_x', body: '{}' });
    expect(res.status).toBe(404);
  });

  it('answers 401 for a missing or wrong key', async () => {
    const a = await createAccount();
    expect((await send('POST', '/ingest/x', { account: a, key: null, body: '{}' })).status).toBe(401);
    expect((await send('POST', '/ingest/x', { account: a, key: 'sw_wrong', body: '{}' })).status).toBe(401);
    expect(await count('events', a)).toBe(0);
  });

  it('answers 403 for a disabled account', async () => {
    const a = await createAccount();
    await appDb.query(`UPDATE accounts SET status = 'disabled' WHERE id = $1`, [a.account_id]);
    expect((await send('POST', '/ingest/x', { account: a, body: '{}' })).status).toBe(403);
    expect(await count('events', a)).toBe(0);
  });

  it('answers 404 for a raw path that is not under /ingest, even if it normalizes into it', async () => {
    const a = await createAccount();
    for (const path of ['/x/../ingest/foo', '/%69ngest/foo', '/ingestx/foo']) {
      const res = await send('POST', path, { account: a, body: '{}' });
      expect(res.status, path).toBe(404);
    }
    expect(await count('events', a)).toBe(0);
  });

  it('does not let dot segments reach internal routes (POST /accounts) or the ingest handler', async () => {
    const slug = `dots-${Date.now().toString(36)}`;
    slugs.push(slug);
    const a = await createAccount();
    for (const path of [
      '/ingest/../accounts',
      '/ingest/%2e%2e/accounts',
      '/ingest/%2E%2E/accounts',
      '/ingest/./foo',
      '/ingest/../ingest/foo',
      '/ingest/foo/..',
    ]) {
      const res = await send('POST', path, { account: a, body: JSON.stringify({ slug }) });
      expect(res.status, path).toBe(404);
    }
    const { rowCount } = await appDb.query('SELECT 1 FROM accounts WHERE slug = $1', [slug]);
    expect(rowCount).toBe(0);
    expect(await count('events', a)).toBe(0);
  });

  it('answers 413 over the body limit', async () => {
    const a = await createAccount();
    const body = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20);
    const res = await send('POST', '/ingest/big', { account: a, body });
    expect(res.status).toBe(413);
    expect(await count('events', a)).toBe(0);
  });

  it('answers 503 when the app database is unreachable', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://u:p@127.0.0.1:1/x' });
    const deadApp = createApp({ appDb: dead, backend, config });
    const res = await deadApp.request('/ingest/x', {
      method: 'POST',
      headers: { 'x-account-slug': 'a', authorization: 'Bearer sw_x' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    await dead.end();
  });
});

describe('stored request context', () => {
  it('stores the path as received, undecoded and unnormalized', async () => {
    const a = await createAccount();
    const path = '/ingest/a%2Fb//c/%7Ed';
    // node:http sends the path untouched: the segment is "a%2Fb" -> "a/b", and the double slash and %7E stay.
    expect((await send('POST', path, { account: a, body: '{}' })).status).toBe(202);
    const [event] = await events(a);
    expect(event!.request.path).toBe(path);
    expect(event!.source).toBe('a/b');
  });

  it('removes auth headers and the key param, lowercases names, and joins repeats', async () => {
    const a = await createAccount();
    const res = await send('POST', `/ingest/h?x=1&key=${a.api_key}&y=%7e`, {
      account: a,
      body: '{}',
      headers: [
        'Cookie', 'a=1',
        'Proxy-Authorization', 'Basic zzz',
        'X-API-Key', 'secret',
        'X-Multi', 'one',
        'x-multi', 'two',
        'Content-Type', 'text/plain',
      ],
    });
    expect(res.status).toBe(202);
    const [event] = await events(a);
    expect(event!.request.method).toBe('POST');
    expect(event!.request.path).toBe('/ingest/h');
    expect(event!.request.query).toBe('x=1&y=%7e');
    const h = event!.request.headers;
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
      expect(h).not.toHaveProperty(name);
    }
    expect(JSON.stringify(event!.request)).not.toContain(a.api_key);
    expect(h['x-multi']).toBe('one, two');
    expect(h['content-type']).toBe('text/plain');
    expect(h['x-account-slug']).toBe(a.slug);
    for (const name of Object.keys(h)) expect(name).toBe(name.toLowerCase());
  });

  it('stores an empty query as an empty string', async () => {
    const a = await createAccount();
    await send('POST', '/ingest/q', { account: a, body: '{}' });
    await send('POST', `/ingest/q?key=${a.api_key}`, { slug: a.slug, key: null, body: '{}' });
    expect((await events(a)).map((e) => e.request.query)).toEqual(['', '']);
  });

  it('ingests a query containing %00 and stores it as text', async () => {
    const a = await createAccount();
    const res = await send('POST', '/ingest/q?a=%00b&c=%FF', { account: a, body: '{}' });
    expect(res.status).toBe(202);
    const [event] = await events(a);
    expect(event!.request.query).toBe('a=%00b&c=%FF');
  });

  it('strips key params by decoded name and leaves the rest untouched', () => {
    expect(stripKeyParam('')).toBe('');
    expect(stripKeyParam('key=abc')).toBe('');
    expect(stripKeyParam('%6bey=abc&a=1')).toBe('a=1');
    expect(stripKeyParam('a=1&%4BEY=x')).toBe('a=1&%4BEY=x'); // different name: case-sensitive
    expect(stripKeyParam('a=1&key=1&b=%00&key=2&key&c')).toBe('a=1&b=%00&c');
    expect(stripKeyParam('a=1&&b=%zz&keys=3&mykey=4')).toBe('a=1&&b=%zz&keys=3&mykey=4');
    expect(stripKeyParam('key%3D=1')).toBe('key%3D=1');
  });

  it('removes an encoded key param from the stored query end to end', async () => {
    const a = await createAccount();
    const res = await send('POST', `/ingest/k?%6bey=${a.api_key}&b=2&key`, {
      slug: a.slug,
      key: null,
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect((await events(a))[0]!.request.query).toBe('b=2');
  });
});

describe('idempotency', () => {
  it('returns the original event for a repeat and creates nothing new', async () => {
    const a = await createAccount();
    const opts = { account: a, body: '{"a":1}', headers: ['Idempotency-Key', 'abc'] };
    const first = await send('POST', '/ingest/i', opts);
    const second = await send('POST', '/ingest/i', { ...opts, body: '{"a":2,"b":3}' });
    expect(second.status).toBe(202);
    expect(second.json).toEqual({ status: 'queued', event_id: first.json.event_id });
    expect(await count('events', a)).toBe(1);
    expect(await count('queue', a)).toBe(1);
  });

  it('is scoped per source and op', async () => {
    const a = await createAccount();
    const headers = ['Idempotency-Key', 'same'];
    const ids = new Set<unknown>();
    for (const [method, path] of [
      ['POST', '/ingest/a'],
      ['POST', '/ingest/b'],
      ['DELETE', '/ingest/a'],
      ['PUT', '/ingest/a'], // same (source, op) as the first POST: a repeat
    ] as const) {
      const res = await send(method, path, { account: a, body: '{"a":1}', headers });
      expect(res.status).toBe(202);
      ids.add(res.json.event_id);
    }
    expect(ids.size).toBe(3);
    expect(await count('events', a)).toBe(3);
  });

  it('is scoped per account', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const headers = ['Idempotency-Key', 'shared'];
    const one = await send('POST', '/ingest/x', { account: a, body: '{}', headers });
    const two = await send('POST', '/ingest/x', { account: b, body: '{}', headers });
    expect(one.json.event_id).not.toBe(two.json.event_id);
  });

  it('returns malformed for a repeat of a malformed event', async () => {
    const a = await createAccount();
    const opts = { account: a, body: '5', headers: ['Idempotency-Key', 'm'] };
    const first = await send('POST', '/ingest/m', opts);
    const second = await send('POST', '/ingest/m', opts);
    expect(first.json.status).toBe('malformed');
    expect(second.json).toEqual({ status: 'malformed', event_id: first.json.event_id });
    expect(await count('events', a)).toBe(1);
    expect(await count('quarantine', a)).toBe(1);
  });

  it('treats an empty Idempotency-Key as absent', async () => {
    const a = await createAccount();
    await send('POST', '/ingest/e', { account: a, body: '{}', headers: ['Idempotency-Key', ''] });
    await send('POST', '/ingest/e', { account: a, body: '{}', headers: ['Idempotency-Key', ''] });
    const rows = await events(a);
    expect(rows).toHaveLength(2);
    expect(rows.every((e) => e.idempotency_key === null)).toBe(true);
  });

  it('dedupes a repeated webhook delivery ID', async () => {
    const a = await createAccount();
    expect(DELIVERY_ID_HEADERS).toEqual(['x-github-delivery', 'x-shopify-webhook-id']);
    const opts = { account: a, body: '{"zen":"x"}', headers: ['X-GitHub-Delivery', 'guid-1'] };
    const first = await send('POST', '/ingest/github', opts);
    const second = await send('POST', '/ingest/github', opts);
    expect(second.json.event_id).toBe(first.json.event_id);
    expect(await count('events', a)).toBe(1);
    expect((await events(a))[0]!.idempotency_key).toBe('guid-1');

    const shopify = { account: a, body: '{}', headers: ['X-Shopify-Webhook-Id', 'sh-1'] };
    const s1 = await send('POST', '/ingest/shopify', shopify);
    const s2 = await send('POST', '/ingest/shopify', shopify);
    expect(s2.json.event_id).toBe(s1.json.event_id);
  });

  it('prefers Idempotency-Key over a delivery header, and github over shopify', async () => {
    const a = await createAccount();
    await send('POST', '/ingest/p', {
      account: a,
      body: '{}',
      headers: ['Idempotency-Key', 'explicit', 'X-GitHub-Delivery', 'g', 'X-Shopify-Webhook-Id', 's'],
    });
    await send('POST', '/ingest/p2', {
      account: a,
      body: '{}',
      headers: ['X-GitHub-Delivery', 'g', 'X-Shopify-Webhook-Id', 's'],
    });
    expect((await events(a)).map((e) => e.idempotency_key)).toEqual(['explicit', 'g']);
  });
});

describe('atomic writes', () => {
  it('pairs every event with exactly one queue or quarantine row', async () => {
    const a = await createAccount();
    for (const body of ['{"a":1}', '7', '[1]', '"s"']) {
      await send('POST', '/ingest/atomic', { account: a, body });
    }
    const { rows } = await appDb.query(
      `SELECT (SELECT count(*) FROM queue q WHERE q.event_id = e.id)::int AS queued,
              (SELECT count(*) FROM quarantine z WHERE z.event_id = e.id)::int AS quarantined
       FROM events e WHERE e.account_id = $1`,
      [a.account_id],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.queued + row.quarantined).toBe(1);
  });

  it.each([
    ['queue', '{"a":1}'],
    ['quarantine', '5'],
  ] as const)('rolls back the event when the %s insert fails', async (table, body) => {
    const a = await createAccount();
    // A CHECK that rejects only this account's rows makes the second insert fail mid-transaction.
    const constraint = `${table}_test_block_${randomBytes(4).toString('hex')}`;
    await appDb.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (account_id <> '${a.account_id}')`,
    );
    try {
      const res = await send('POST', '/ingest/fail', { account: a, body });
      expect(res.status).toBe(500);
    } finally {
      await appDb.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
    }
    expect(await count('events', a)).toBe(0);
  });
});

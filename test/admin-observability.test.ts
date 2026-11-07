import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createUser } from '../src/admin/users.js';
import { buildSchemaTables, getPipeline, getTraffic } from '../src/admin/stats.js';
import { encryptJson } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';
import { readOnlyRoleName } from '../src/storage/postgres/sql.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });
const dataUrl = new URL(config.dataDatabaseUrl);
const connection = {
  host: dataUrl.hostname,
  port: Number(dataUrl.port),
  database: dataUrl.pathname.slice(1),
};
const credentials = {
  user: decodeURIComponent(dataUrl.username),
  password: decodeURIComponent(dataUrl.password),
};

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const userIds: string[] = [];
const accountIds: string[] = [];
const namespaces: string[] = [];

interface Seeded {
  id: string;
  slug: string;
  storeId: string;
  namespace: string;
}

async function newUser(label: string, isSuperAdmin = false) {
  const email = `${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  return { id, email };
}

async function login(email: string) {
  const res = await app.request('http://localhost/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
  });
  expect(res.status).toBe(303);
  return { cookie: `sw_admin=${/sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}` };
}

const get = (path: string, s: { cookie: string }, fragment = false) =>
  app.request(path, { headers: { cookie: s.cookie, ...(fragment ? { 'x-admin-fragment': '1' } : {}) } });

/** An account with an active store whose own database is real, unless `reachable` is false. */
async function newAccount(label: string, reachable = true): Promise<Seeded> {
  const slug = `pg-${label}-${tag}`;
  const accountId = (
    await appDb.query<{ id: string }>(
      `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
      [slug],
    )
  ).rows[0]!.id;
  accountIds.push(accountId);
  const namespace = `t_${randomBytes(6).toString('hex')}_pg`;
  namespaces.push(namespace);
  const storeId = (
    await appDb.query<{ id: string }>(
      `INSERT INTO account_stores (account_id, generation, backend, connection, credentials, namespace, status)
       VALUES ($1, 1, 'postgres', $2, $3, $4, 'active') RETURNING id`,
      [
        accountId,
        JSON.stringify(reachable ? connection : { ...connection, port: 1 }),
        encryptJson(config.encryptionKey, credentials),
        namespace,
      ],
    )
  ).rows[0]!.id;
  return { id: accountId, slug, storeId, namespace };
}

async function addTables(a: Seeded, tables: Record<string, Record<string, string>>) {
  for (const [table, columns] of Object.entries(tables)) {
    for (const [column, type] of Object.entries({ id: 'string', ...columns })) {
      await appDb.query(
        'INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, $2, $3, $4)',
        [a.storeId, table, column, type],
      );
    }
  }
}

/** Creates the tables in the store's database and inserts `live` live rows plus `deleted` soft-deleted ones. */
async function fillStore(a: Seeded, rows: Record<string, [live: number, deleted: number]>) {
  const store = { namespace: a.namespace, connection, credentials };
  await backend.provision(store);
  await backend.applySchema(
    store,
    Object.keys(rows).map((table) => ({ kind: 'create_table' as const, table })),
  );
  const client = new pg.Client({ ...connection, ...credentials, database: a.namespace });
  await client.connect();
  try {
    for (const [table, [live, deleted]] of Object.entries(rows)) {
      const t = pg.escapeIdentifier(table);
      for (let i = 0; i < live + deleted; i++) {
        await client.query(
          `INSERT INTO ${t} (id, _event_seq, _deleted_at) VALUES ($1, 1, $2)`,
          [`${table}-${i}`, i < live ? null : new Date()],
        );
      }
    }
  } finally {
    await client.end();
  }
}

async function addEvent(
  accountId: string,
  source: string,
  op: 'write' | 'delete',
  secondsAgo: number,
): Promise<string> {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO events (account_id, body, source, op, request, received_at)
     VALUES ($1, '\\x7b7d', $2, $3, '{}', now() - make_interval(secs => $4)) RETURNING id`,
    [accountId, source, op, secondsAgo],
  );
  return rows[0]!.id;
}

async function addJob(accountId: string, eventId: string, attempts: number, secondsAgo: number) {
  await appDb.query(
    `INSERT INTO queue (account_id, kind, event_id, attempts, created_at)
     VALUES ($1, 'ingest', $2, $3, now() - make_interval(secs => $4))`,
    [accountId, eventId, attempts, secondsAgo],
  );
}

let a: Seeded;
let b: Seeded;
let member: { id: string; email: string };
let session: { cookie: string };

beforeAll(async () => {
  a = await newAccount('a');
  b = await newAccount('b');
  member = await newUser('member');
  await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [a.id, member.id]);
  session = await login(member.email);

  // Account A: customer <- purchase <- item, plus an unrelated table.
  await addTables(a, {
    customer: { name: 'string', signed_up: 'timestamp' },
    purchase: { customer_id: 'string', total: 'number' },
    item: { purchase_id: 'string', gift: 'boolean' },
    note: { other_id: 'string' }, // no table "other": not a child link
  });
  await fillStore(a, { customer: [2, 1], purchase: [1, 0], item: [0, 2], note: [0, 0] });

  // Account B: data that must never show up on A's pages.
  await addTables(b, { secretb: { b_only_column: 'string' } });
  await fillStore(b, { secretb: [7, 0] });

  // Traffic for A: minute 0 has 3 orders writes and 1 pathless write, minute 1 has 2 writes and 1 delete.
  for (const s of [5, 20, 40]) await addEvent(a.id, 'orders', 'write', s);
  await addEvent(a.id, '', 'write', 10);
  for (const s of [70, 80]) await addEvent(a.id, 'orders', 'write', s);
  await addEvent(a.id, 'orders', 'delete', 90);
  await addEvent(a.id, 'orders', 'write', 2 * 3600); // outside the window

  // Pipeline for A.
  await addJob(a.id, await addEvent(a.id, 'queued', 'write', 700), 0, 600);
  await addJob(a.id, await addEvent(a.id, 'queued', 'write', 700), 1, 300);
  await addJob(a.id, await addEvent(a.id, 'queued', 'write', 700), 3, 120);
  await appDb.query(
    `INSERT INTO queue (account_id, kind, store_id, attempts) VALUES ($1, 'rebuild', $2, 2)`,
    [a.id, a.storeId],
  );

  // Same shapes for B, with distinctive values.
  for (let i = 0; i < 9; i++) await addEvent(b.id, 'othersource', 'write', 5);
  await addJob(b.id, await addEvent(b.id, 'othersource', 'write', 700), 9, 5000);
});

afterAll(async () => {
  await backend.close();
  for (const id of accountIds) {
    await appDb.query('DELETE FROM queue WHERE account_id = $1', [id]);
    await appDb.query('DELETE FROM events WHERE account_id = $1', [id]);
  }
  await appDb.query('DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = ANY($1))', [accountIds]);
  await appDb.query('DELETE FROM account_stores WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  const admin = new pg.Client({ ...connection, ...credentials });
  await admin.connect();
  for (const namespace of namespaces) {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(namespace)} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
  await admin.end();
  await appDb.end();
});

/** The text of the table section for one table on the Schema page. */
function tableSection(html: string, table: string): string {
  const start = html.indexOf(`data-table="${table}"`);
  expect(start, `table ${table}`).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

describe('schema page', () => {
  it('lists tables, columns and types with parent and child links and live row counts', async () => {
    const res = await get(`/admin/accounts/${a.id}/schema`, session);
    expect(res.status).toBe(200);
    const html = await res.text();

    const customer = tableSection(html, 'customer');
    expect(customer).toContain('2 rows'); // the soft-deleted row is excluded
    expect(customer).toContain('<code>name</code>');
    expect(customer).toContain('signed_up');
    expect(customer).toContain('timestamp');
    expect(customer).toContain('Parent of: purchase');
    expect(customer).not.toContain('Child of');
    expect(customer).not.toContain('<code>id</code>');

    const purchase = tableSection(html, 'purchase');
    expect(purchase).toContain('1 rows');
    expect(purchase).toContain('Child of: customer');
    expect(purchase).toContain('Parent of: item');

    const item = tableSection(html, 'item');
    expect(item).toContain('0 rows'); // all soft-deleted
    expect(item).toContain('Child of: purchase');

    const note = tableSection(html, 'note');
    expect(note).not.toContain('Child of');
  });

  it('shows another account\'s data only on that account', async () => {
    const html = await (await get(`/admin/accounts/${a.id}/schema`, session)).text();
    expect(html).not.toContain('secretb');
    expect(html).not.toContain('b_only_column');
    expect(html).not.toContain(b.slug);

    // The member has no access to B at all.
    expect((await get(`/admin/accounts/${b.id}/schema`, session)).status).toBe(404);
  });

  it('still renders, with counts unavailable, when the store database is unreachable', async () => {
    const down = await newAccount('down', false);
    await addTables(down, { widget: { label: 'string' } });
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [down.id, member.id]);
    const res = await get(`/admin/accounts/${down.id}/schema`, session);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('widget');
    expect(html).toContain('label');
    expect(html).toContain('— rows');
    expect(html).toContain('Row counts are unavailable');
  });

  it('shows a dash for a table that is missing from the store database', async () => {
    const partial = await newAccount('partial');
    await addTables(partial, { present: {}, ghost: {} });
    await fillStore(partial, { present: [4, 0] });
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [partial.id, member.id]);
    const html = await (await get(`/admin/accounts/${partial.id}/schema`, session)).text();
    expect(tableSection(html, 'present')).toContain('4 rows');
    expect(tableSection(html, 'ghost')).toContain('— rows');
  });

  it('shows a dash for a table whose count hits the 2s statement timeout, and counts the rest', async () => {
    const slow = await newAccount('slow');
    await addTables(slow, { aaa_locked: {}, zzz_free: {} });
    await fillStore(slow, { aaa_locked: [1, 0], zzz_free: [3, 0] });
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [slow.id, member.id]);

    // An exclusive lock in an open transaction makes count(*) on that table wait.
    const locker = new pg.Client({ ...connection, ...credentials, database: slow.namespace });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE "aaa_locked" IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const html = await (await get(`/admin/accounts/${slow.id}/schema`, session)).text();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      expect(tableSection(html, 'aaa_locked')).toContain('— rows');
      expect(tableSection(html, 'zzz_free')).toContain('3 rows');
    } finally {
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
  });

  it('says so when the account has no active store', async () => {
    const empty = (
      await appDb.query<{ id: string }>(
        `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
        [`pg-empty-${tag}`],
      )
    ).rows[0]!.id;
    accountIds.push(empty);
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [empty, member.id]);
    const html = await (await get(`/admin/accounts/${empty}/schema`, session)).text();
    expect(html).toContain('no active store');
  });

  it('infers links only to tables that exist', () => {
    const tables = buildSchemaTables([
      ['a', 'id', 'string'],
      ['b', 'id', 'string'],
      ['b', 'a_id', 'string'],
      ['b', 'b_id', 'string'], // self reference is not a parent link
      ['b', 'zzz_id', 'string'],
    ]);
    expect(tables.map((t) => [t.name, t.parents, t.children])).toEqual([
      ['a', [], ['b']],
      ['b', ['a'], []],
    ]);
  });
});

describe('traffic page', () => {
  it('buckets the last hour by minute and totals by source and op', async () => {
    const traffic = await getTraffic(appDb, a.id);
    // Seeded: 3 + 1 events in minute 0, 3 in minute 1, and 3 queued events 700s (minute 11) ago.
    expect(traffic.rows.filter((r) => r.minutesAgo === 0)).toEqual([
      { minutesAgo: 0, source: '', op: 'write', count: 1 },
      { minutesAgo: 0, source: 'orders', op: 'write', count: 3 },
    ]);
    expect(traffic.rows.filter((r) => r.minutesAgo === 1)).toEqual([
      { minutesAgo: 1, source: 'orders', op: 'delete', count: 1 },
      { minutesAgo: 1, source: 'orders', op: 'write', count: 2 },
    ]);
    expect(traffic.bySource).toEqual([
      { source: '', count: 1 },
      { source: 'orders', count: 6 },
      { source: 'queued', count: 3 },
    ]);
    expect(traffic.byOp).toEqual([
      { op: 'delete', count: 1 },
      { op: 'write', count: 9 },
    ]);
    expect(traffic.total).toBe(10); // the event from two hours ago is excluded
  });

  it('renders an inline SVG chart and the table, and hides other accounts', async () => {
    const html = await (await get(`/admin/accounts/${a.id}/traffic`, session)).text();
    expect(html).toContain('<svg');
    expect(html).toContain('0 min ago: 4 writes, 0 deletes');
    expect(html).toContain('1 min ago: 2 writes, 1 deletes');
    expect(html).toContain('(no path)');
    expect(html).toContain('orders');
    expect(html).toContain('10 in the last hour');
    expect(html).not.toContain('othersource');
  });
});

describe('pipeline page', () => {
  it('reports depth by kind, the oldest job and retries', async () => {
    const pipeline = await getPipeline(appDb, a.id);
    expect(pipeline.depthByKind).toEqual([
      { kind: 'ingest', count: 3 },
      { kind: 'rebuild', count: 1 },
    ]);
    expect(pipeline.depth).toBe(4);
    expect(pipeline.oldestAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(pipeline.oldestAgeSeconds).toBeLessThan(620);
    expect(pipeline.retries.map((r) => [r.kind, r.attempts])).toEqual([
      ['ingest', 3],
      ['rebuild', 2],
    ]);

    const html = await (await get(`/admin/accounts/${a.id}/pipeline`, session)).text();
    expect(html).toMatch(/data-depth="true">4</);
    expect(html).toMatch(/data-oldest="true">10m \d+s</);
    expect(html).not.toContain('othersource');
    expect(html).not.toContain('83m'); // B's oldest job is 5000s old
  });

  it('shows an empty queue', async () => {
    const quiet = await newAccount('quiet');
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [quiet.id, member.id]);
    const html = await (await get(`/admin/accounts/${quiet.id}/pipeline`, session)).text();
    expect(html).toMatch(/data-depth="true">0</);
    expect(html).toMatch(/data-oldest="true">—</);
    expect(html).toContain('No jobs have been retried');
  });
});

describe('live refresh', () => {
  it.each(['schema', 'traffic', 'pipeline'])(
    '%s returns only the region for a fragment request and the full page otherwise',
    async (page) => {
      const full = await (await get(`/admin/accounts/${a.id}/${page}`, session)).text();
      expect(full).toContain('<html');
      expect(full).toContain('data-live-region');
      expect(full).toContain('X-Admin-Fragment');
      expect(full).not.toContain('http-equiv="refresh"');

      const res = await get(`/admin/accounts/${a.id}/${page}`, session, true);
      expect(res.status).toBe(200);
      const fragment = await res.text();
      expect(fragment).not.toContain('<html');
      expect(fragment).not.toContain('<script');
      expect(fragment).not.toContain('data-live-region');
      expect(full).toContain(fragment);
    },
  );

  it('redirects a fragment request without a session, so the script stops', async () => {
    const res = await app.request(`/admin/accounts/${a.id}/schema`, {
      headers: { 'x-admin-fragment': '1' },
    });
    expect(res.status).toBe(303);
  });
});

describe('access', () => {
  it('lets a super admin view any account, and refuses a user with no membership', async () => {
    const admin = await newUser('super', true);
    const stranger = await newUser('stranger');
    const s = await login(admin.email);
    for (const page of ['schema', 'traffic', 'pipeline']) {
      expect((await get(`/admin/accounts/${a.id}/${page}`, s)).status).toBe(200);
      expect((await get(`/admin/accounts/${a.id}/${page}`, await login(stranger.email))).status).toBe(404);
    }
  });
});

// The admin's Pipeline page (event statuses, filters, lookup) and the Schema page's waiting notice.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createUser } from '../src/admin/users.js';
import { encryptJson } from '../src/secrets.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const userIds: string[] = [];
const accountIds: string[] = [];
let session: { cookie: string };
let memberId: string;

async function login(email: string) {
  const res = await app.request('http://localhost/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
  });
  expect(res.status).toBe(303);
  return { cookie: `sw_admin=${/sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}` };
}

const get = (path: string, fragment = false) =>
  app.request(path, { headers: { cookie: session.cookie, ...(fragment ? { 'x-admin-fragment': '1' } : {}) } });
const page = async (path: string, fragment = false) => {
  const res = await get(path, fragment);
  expect(res.status).toBe(200);
  return res.text();
};
/** Visible text, tags removed and whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

const fp = () => `fp-${randomBytes(4).toString('hex')}`;

/** An account the member can see, with an active store whose database isn't reachable (no row counts needed). */
async function newAccount(label: string) {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
    [`ap-${label}-${tag}`],
  );
  const id = rows[0]!.id;
  accountIds.push(id);
  await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [id, memberId]);
  const store = await appDb.query<{ id: string }>(
    `INSERT INTO account_stores (account_id, generation, backend, connection, credentials, namespace, status)
     VALUES ($1, 1, 'postgres', $2, $3, $4, 'active') RETURNING id`,
    [
      id,
      JSON.stringify({ host: '127.0.0.1', port: 1, database: 'none' }),
      encryptJson(config.encryptionKey, { user: 'none', password: 'none' }),
      `t_${randomBytes(6).toString('hex')}_ap`,
    ],
  );
  const storeId = store.rows[0]!.id;
  return {
    id,
    async event(fingerprint: string | null, source = ''): Promise<string> {
      const { rows } = await appDb.query<{ id: string }>(
        `INSERT INTO events (account_id, body, source, op, fingerprint, request)
         VALUES ($1, $2, $3, 'write', $4, $5) RETURNING id`,
        [id, Buffer.from('{"card":"payload-secret"}'), source, fingerprint, { headers: { 'x-api': 'header-secret' } }],
      );
      return rows[0]!.id;
    },
    job: (eventId: string) =>
      appDb.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [id, eventId]),
    quarantine: (eventId: string, reason: string, detail: string | null = null) =>
      appDb.query(`INSERT INTO quarantine (event_id, account_id, reason, detail) VALUES ($1, $2, $3, $4)`, [
        eventId,
        id,
        reason,
        detail,
      ]),
    attempt: (fingerprint: string, status: string, detail: string | null = null, source = '') =>
      appDb.query(
        `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status, detail, finished_at)
         VALUES ($1, $2, 'write', $3, $4, $5, CASE WHEN $4 = 'running' THEN NULL ELSE now() END)`,
        [id, source, fingerprint, status, detail],
      ),
    adapter: (fingerprint: string) =>
      appDb.query(
        `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, validated_at)
         VALUES ($1, '', 'write', $2, 1, '', now())`,
        [id, fingerprint],
      ),
    addTable: (table: string) =>
      appDb.query(
        `INSERT INTO data_columns (store_id, table_name, column_name, logical_type) VALUES ($1, $2, 'id', 'string')`,
        [storeId, table],
      ),
  };
}

type Account = Awaited<ReturnType<typeof newAccount>>;

let busy: Account;
let ids: Record<'written' | 'malformed' | 'writeError' | 'waiting' | 'waiting2' | 'generating' | 'queued', string>;
let other: Account;
let otherEvent: string;

beforeAll(async () => {
  const email = `member-${tag}@example.test`;
  memberId = (await createUser(appDb, { email, password: PASSWORD, isSuperAdmin: false })).id;
  userIds.push(memberId);
  session = await login(email);

  busy = await newAccount('busy');
  const generatingShape = fp();
  const waitingShape = fp();
  ids = {} as typeof ids;
  ids.written = await busy.event(fp(), 'shopify');
  ids.malformed = await busy.event(null, 'stripe');
  await busy.quarantine(ids.malformed, 'malformed', 'not_object_or_array');
  ids.writeError = await busy.event(fp(), 'stripe');
  await busy.quarantine(ids.writeError, 'write_error', 'connection_refused');
  ids.waiting = await busy.event(waitingShape, '');
  await busy.quarantine(ids.waiting, 'unknown_fingerprint');
  ids.waiting2 = await busy.event(waitingShape, '');
  await busy.quarantine(ids.waiting2, 'unknown_fingerprint');
  await busy.attempt(waitingShape, 'failed', 'gave_up');
  await busy.adapter(waitingShape);
  ids.generating = await busy.event(generatingShape, 'shopify');
  await busy.quarantine(ids.generating, 'unknown_fingerprint');
  await busy.attempt(generatingShape, 'running', null, 'shopify');
  ids.queued = await busy.event(fp(), 'shopify');
  await busy.job(ids.queued);

  other = await newAccount('other');
  otherEvent = await other.event(fp(), 'othersource');
  await other.quarantine(otherEvent, 'malformed', 'theirs');
});

afterAll(async () => {
  await backend.close();
  for (const table of ['queue', 'quarantine', 'adapter_attempts', 'adapters', 'events']) {
    await appDb.query(`DELETE FROM ${table} WHERE account_id = ANY($1)`, [accountIds]);
  }
  await appDb.query(
    'DELETE FROM data_columns WHERE store_id IN (SELECT id FROM account_stores WHERE account_id = ANY($1))',
    [accountIds],
  );
  await appDb.query('DELETE FROM account_stores WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

/** The HTML of one event's feed row. */
function row(html: string, eventId: string): string {
  const start = html.indexOf(`data-event="${eventId}"`);
  expect(start, `row for ${eventId}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</tr>', start));
}

const pipelinePath = () => `/admin/accounts/${busy.id}/pipeline`;

describe('pipeline status', () => {
  it('says what is waiting, generating, failed, awaiting approval, and stuck', async () => {
    const status = text(await page(pipelinePath()));
    expect(status).toContain('3 events waiting for an adapter (2 new shapes)');
    expect(status).toContain('AI is generating 1 adapter');
    expect(status).toContain('Last attempt failed: gave_up ((no path) / write)');
    expect(status).toContain('1 adapter awaiting approval');
    expect(status).toContain("2 need attention: The body isn't a JSON object or array (1); Writing to the account's store failed (1)");
    expect(status).not.toContain('Nothing is waiting');
  });

  it('says nothing is waiting when every event has been processed', async () => {
    const calm = await newAccount('calm');
    await calm.event(fp());
    expect(text(await page(`/admin/accounts/${calm.id}/pipeline`))).toContain(
      'Nothing is waiting. Every event has been processed.',
    );
  });

  it('points an account with no events to the Connect page', async () => {
    const empty = await newAccount('empty');
    const html = await page(`/admin/accounts/${empty.id}/pipeline`);
    expect(text(html)).toContain('No events yet. Send your first one');
    expect(html).toContain(`href="/admin/accounts/${empty.id}/connect"`);
    expect(html).not.toContain('data-filters');
    expect(html).toMatch(/data-depth="true">0</); // the queue stays
  });
});

describe('recent events', () => {
  it('lists events newest first with badges, notes, and links to each event', async () => {
    const html = await page(pipelinePath());
    const order = [ids.queued, ids.generating, ids.waiting2, ids.waiting, ids.writeError, ids.malformed, ids.written];
    const positions = order.map((id) => html.indexOf(`data-event="${id}"`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);

    expect(row(html, ids.queued)).toContain('>Queued<');
    expect(row(html, ids.generating)).toContain('>AI generating<');
    expect(row(html, ids.waiting)).toContain('>Waiting for adapter<');
    expect(row(html, ids.malformed)).toContain('>Needs attention<');
    expect(row(html, ids.written)).toContain('>Written<');

    expect(row(html, ids.waiting)).toContain('No adapter handles this shape yet, gave_up, awaiting approval');
    expect(row(html, ids.malformed)).toContain('The body isn&#39;t a JSON object or array');
    expect(row(html, ids.writeError)).toContain('Writing to the account&#39;s store failed');
    expect(row(html, ids.waiting)).toContain('(no path)');
    expect(row(html, ids.written)).toContain(`href="/admin/accounts/${busy.id}/events/${ids.written}"`);
  });

  it('notes a replayed event', async () => {
    const replay = await newAccount('replay');
    const shape = fp();
    const eventId = await replay.event(shape);
    await replay.quarantine(eventId, 'unknown_fingerprint');
    const { rows } = await appDb.query<{ id: string }>(
      `INSERT INTO adapters (account_id, op, fingerprint, version, code, active, validated_at)
       VALUES ($1, 'write', $2, 1, '', true, now()) RETURNING id`,
      [replay.id, shape],
    );
    await appDb.query('UPDATE quarantine SET released_at = now(), released_by_adapter_id = $2 WHERE event_id = $1', [
      eventId,
      rows[0]!.id,
    ]);
    const html = await page(`/admin/accounts/${replay.id}/pipeline`);
    expect(row(html, eventId)).toContain('>Written<');
    expect(row(html, eventId)).toContain('replayed');
  });

  it('shows the last 25', async () => {
    const many = await newAccount('many');
    const made: string[] = [];
    for (let i = 0; i < 27; i++) made.push(await many.event(fp()));
    const html = await page(`/admin/accounts/${many.id}/pipeline`);
    expect(html.match(/data-event="/g)).toHaveLength(25);
    expect(html).not.toContain(`data-event="${made[1]}"`);
    expect(html).toContain(`data-event="${made[26]}"`);
  });

  it('never shows payloads, request headers, or another account', async () => {
    for (const fragment of [false, true]) {
      const html = await page(pipelinePath(), fragment);
      expect(html).not.toContain('payload-secret');
      expect(html).not.toContain('header-secret');
      expect(html).not.toContain('othersource');
      expect(html).not.toContain(otherEvent);
      expect(html).not.toContain('theirs');
    }
  });
});

describe('filters', () => {
  it('offers every source and status, and filters by both from the query string', async () => {
    const html = await page(pipelinePath());
    expect(html).toContain('All sources');
    expect(html).toMatch(/<option value="\/"[^>]*>\(no path\)<\/option>/);
    expect(html).toMatch(/<option value="shopify"[^>]*>shopify<\/option>/);
    expect(html).toMatch(/<option value="stripe"[^>]*>stripe<\/option>/);
    for (const label of ['All', 'Queued', 'AI generating', 'Waiting for adapter', 'Needs attention', 'Written']) {
      expect(html).toContain(`>${label}</option>`);
    }

    const shopify = await page(`${pipelinePath()}?source=shopify&status=`);
    expect(shopify.match(/data-event="/g)).toHaveLength(3);
    expect(shopify).toMatch(/<option value="shopify" selected="">/);

    const bare = await page(`${pipelinePath()}?source=%2F`);
    expect(bare.match(/data-event="/g)).toHaveLength(2);
    expect(bare).toContain(`data-event="${ids.waiting}"`);

    const stuck = await page(`${pipelinePath()}?status=quarantined`);
    expect(stuck.match(/data-event="/g)).toHaveLength(2);
    expect(stuck).toMatch(/<option value="quarantined" selected="">/);

    const both = await page(`${pipelinePath()}?source=stripe&status=written`);
    expect(both).not.toContain('data-event="');
    expect(both).toContain('No recent events match these filters.');

    // An unknown status is ignored rather than an error.
    expect((await page(`${pipelinePath()}?status=bogus`)).match(/data-event="/g)).toHaveLength(7);
  });

  it('keeps the filters on a fragment refresh, which fetches the same URL', async () => {
    const path = `${pipelinePath()}?source=shopify&status=queued`;
    const fragment = await page(path, true);
    expect(fragment).not.toContain('<html');
    expect(fragment.match(/data-event="/g)).toHaveLength(1);
    expect(fragment).toContain(`data-event="${ids.queued}"`);
    expect(fragment).toMatch(/<option value="shopify" selected="">/);
    expect(fragment).toMatch(/<option value="queued" selected="">/);
    expect(await page(path)).toContain(fragment);
    // The refresh script refetches location.href, query string included.
    expect(await page(path)).toContain('fetch(location.href');
  });
});

describe('event lookup', () => {
  it('goes to the event page for a UUID', async () => {
    const id = randomUUID();
    const res = await get(`${pipelinePath()}?event=${id.toUpperCase()}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/admin/accounts/${busy.id}/events/${id}`);
  });

  it('refuses anything else, without leaving the page', async () => {
    const res = await get(`${pipelinePath()}?event=${encodeURIComponent('<b>not-an-id</b>')}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("That isn&#39;t an event ID");
    expect(html).not.toContain('<b>not-an-id</b>');
    expect(html).toContain('Look up an event ID');
    expect(html).toMatch(/<input[^>]+name="event"[^>]+pattern="/);
  });
});

describe('refresh', () => {
  it('refreshes Pipeline every 2.5s and the other pages every 5s', async () => {
    const pipeline = await page(pipelinePath());
    expect(pipeline).toContain('data-live-interval="2500"');
    expect(pipeline).toContain('}, 2500);');
    for (const other of ['schema', 'traffic']) {
      const html = await page(`/admin/accounts/${busy.id}/${other}`);
      expect(html).toContain('data-live-interval="5000"');
      expect(html).toContain('}, 5000);');
    }
  });

  it('answers a fragment request with only the live content', async () => {
    const fragment = await page(pipelinePath(), true);
    expect(fragment).not.toContain('<html');
    expect(fragment).not.toContain('<script');
    expect(fragment).toContain('data-status');
    expect(fragment).toContain('data-events');
    expect(fragment).toContain('data-depth');
  });
});

describe('schema page', () => {
  it('says how many events are waiting when there are no tables yet', async () => {
    const fresh = await newAccount('fresh');
    const shape = fp();
    await fresh.quarantine(await fresh.event(shape), 'unknown_fingerprint');
    await fresh.quarantine(await fresh.event(shape), 'unknown_fingerprint');
    const html = await page(`/admin/accounts/${fresh.id}/schema`);
    expect(text(html)).toContain('No tables yet. 2 events are waiting for an adapter to be generated (1 new shape)');
    expect(html).toContain('<strong>2 events</strong>');
    expect(html).toContain(`href="/admin/accounts/${fresh.id}/pipeline"`);
  });

  it('adds a notice above existing tables while events are waiting', async () => {
    await busy.addTable('orders');
    const html = await page(`/admin/accounts/${busy.id}/schema`);
    expect(text(html)).toContain('3 events (2 new shapes) are waiting for an adapter');
    expect(html.indexOf('data-waiting')).toBeLessThan(html.indexOf('data-table="orders"'));
    expect(html).toContain(`href="/admin/accounts/${busy.id}/pipeline"`);
  });

  it('is unchanged when nothing is waiting', async () => {
    const calm = await newAccount('calm-schema');
    expect(text(await page(`/admin/accounts/${calm.id}/schema`))).toContain(
      'No tables yet. They appear as data arrives.',
    );
    await calm.addTable('things');
    const html = await page(`/admin/accounts/${calm.id}/schema`);
    expect(html).toContain('data-table="things"');
    expect(html).not.toContain('data-waiting');
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { PAYLOAD_LIMIT } from '../src/admin/pages/events.js';
import { createUser } from '../src/admin/users.js';
import { reasonLabel } from '../src/pipeline/labels.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const backend = new PostgresBackend({ idleTimeoutMs: 50 });
const app = createApp({ appDb, backend, config });

const ORIGIN = 'http://localhost';
const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const userIds: string[] = [];
const accountIds: string[] = [];

// Distinctive values that must only ever appear in the payload view.
const BODY_SECRET = `zebra-body-${tag}`;
const HEADER_SECRET = `heron-header-${tag}`;
const QUERY_SECRET = `quail-query-${tag}`;
const REPLAY_DETAIL = `replay-detail-${tag}`;
const QUARANTINE_DETAIL = `quarantine-detail-${tag}`;

interface Session {
  headers: { cookie: string };
  csrf: string;
}

async function newUser(label: string, isSuperAdmin = false) {
  const email = `${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  return { id, email };
}

async function login(email: string): Promise<Session> {
  const res = await app.request(`${ORIGIN}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
  });
  expect(res.status).toBe(303);
  const headers = { cookie: `sw_admin=${/sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}` };
  const html = await (await app.request('/admin', { headers })).text();
  return { headers, csrf: /name="_csrf" value="([^"]+)"/.exec(html)![1]! };
}

async function newAccount(label: string): Promise<string> {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
    [`ev-${label}-${tag}`],
  );
  accountIds.push(rows[0]!.id);
  return rows[0]!.id;
}

async function addEvent(
  accountId: string,
  opts: {
    source?: string;
    op?: 'write' | 'delete';
    fingerprint?: string | null;
    body?: Buffer | string;
    request?: object;
  } = {},
): Promise<string> {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO events (account_id, body, source, op, fingerprint, request)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      accountId,
      Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body ?? '{}'),
      opts.source ?? 'orders',
      opts.op ?? 'write',
      opts.fingerprint === undefined ? `fp-${randomBytes(4).toString('hex')}` : opts.fingerprint,
      JSON.stringify(opts.request ?? { method: 'POST', path: '/ingest/orders', query: '', headers: {} }),
    ],
  );
  return rows[0]!.id;
}

async function addQuarantine(accountId: string, eventId: string, reason: string, released?: string) {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO quarantine (account_id, event_id, reason, detail, released_at, released_by_adapter_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [accountId, eventId, reason, QUARANTINE_DETAIL, released ? new Date() : null, released ?? null],
  );
  return rows[0]!.id;
}

async function addAdapter(
  accountId: string,
  shape: { source: string; fingerprint: string },
  opts: { active: boolean; validated: boolean },
) {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, active, validated_at)
     VALUES ($1, $2, 'write', $3, 1, 'export default () => []', $4, $5) RETURNING id`,
    [accountId, shape.source, shape.fingerprint, opts.active, opts.validated ? new Date() : null],
  );
  return rows[0]!.id;
}

async function addAttempt(accountId: string, shape: { source: string; fingerprint: string }, status: string, detail?: string) {
  await appDb.query(
    `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status, detail, finished_at)
     VALUES ($1, $2, 'write', $3, $4, $5, $6)`,
    [accountId, shape.source, shape.fingerprint, status, detail ?? null, status === 'running' ? null : new Date()],
  );
}

const get = (path: string, s: Session) => app.request(path, { headers: s.headers });

const post = (path: string, s: Session, fields: Record<string, string>) =>
  app.request(path, {
    method: 'POST',
    headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams(fields).toString(),
  });

const unescapeHtml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** The text inside the element carrying `attr`. */
function section(html: string, attr: string, close: string): string {
  const start = html.indexOf(attr);
  expect(start, attr).toBeGreaterThan(-1);
  const open = html.indexOf('>', start) + 1;
  return html.slice(open, html.indexOf(close, open));
}

let a: string;
let b: string;
let member: Session;
let superAdmin: Session;
const ev: Record<string, string> = {};
const path = (eventId: string, accountId = a) => `/admin/accounts/${accountId}/events/${eventId}`;

beforeAll(async () => {
  a = await newAccount('a');
  b = await newAccount('b');
  const m = await newUser('member');
  await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [a, m.id]);
  member = await login(m.email);
  superAdmin = await login((await newUser('super', true)).email);

  // queued: a job with two claims.
  ev.queued = await addEvent(a, { source: '' });
  await appDb.query(`INSERT INTO queue (account_id, kind, event_id, attempts) VALUES ($1, 'ingest', $2, 2)`, [a, ev.queued]);

  // adapter_generating: unknown shape with a running generation.
  const generating = { source: 'gen', fingerprint: `fp-gen-${tag}` };
  ev.generating = await addEvent(a, generating);
  await addQuarantine(a, ev.generating, 'unknown_fingerprint');
  await addAttempt(a, generating, 'running');

  // waiting: unknown shape whose last generation failed, with a validated adapter awaiting approval.
  const waiting = { source: 'wait', fingerprint: `fp-wait-${tag}` };
  ev.waiting = await addEvent(a, waiting);
  await addQuarantine(a, ev.waiting, 'unknown_fingerprint');
  await addAttempt(a, waiting, 'failed', 'invalid_output');
  await addAdapter(a, waiting, { active: false, validated: true });

  // quarantined: a malformed body.
  ev.quarantined = await addEvent(a, { source: 'bad', fingerprint: null, body: 'not json' });
  await addQuarantine(a, ev.quarantined, 'malformed');

  // written, through a replay after being quarantined.
  const replayed = { source: 'rep', fingerprint: `fp-rep-${tag}` };
  ev.replayed = await addEvent(a, { ...replayed, body: '{"n":12345}' });
  const adapterId = await addAdapter(a, replayed, { active: true, validated: true });
  const qid = await addQuarantine(a, ev.replayed, 'adapter_error', adapterId);
  for (const [status, at] of [
    ['failed', '2026-01-01T10:00:00Z'],
    ['succeeded', '2026-01-01T11:00:00Z'],
  ]) {
    await appDb.query(
      `INSERT INTO replay_log (account_id, quarantine_id, adapter_id, status, detail, attempted_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [a, qid, adapterId, status, REPLAY_DETAIL, at],
    );
  }

  // written, plainly, with distinctive payload and request values.
  ev.secret = await addEvent(a, {
    source: 'hooks',
    body: JSON.stringify({ customer: BODY_SECRET, html: '<script>alert(1)</script>', n: [1, 2] }),
    request: {
      method: 'PUT',
      path: '/ingest/hooks/x',
      query: `token=${QUERY_SECRET}`,
      headers: { 'content-type': 'application/json', 'x-signature': HEADER_SECRET },
    },
  });

  ev.big = await addEvent(a, { source: 'big', body: Buffer.alloc(150 * 1024, 'a') });
  ev.rawHtml = await addEvent(a, { source: 'raw', fingerprint: null, body: '<img src=x onerror=alert(1)>' });

  ev.other = await addEvent(b, { source: 'theirs', body: JSON.stringify({ b: BODY_SECRET }) });
});

afterAll(async () => {
  await backend.close();
  await appDb.query('DELETE FROM replay_log WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM quarantine WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM adapter_attempts WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM adapters WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM queue WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM events WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

async function eventHtml(eventId: string, s: Session = member): Promise<string> {
  const res = await get(path(eventId), s);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return res.text();
}

/** A `data-field` value as text: tags stripped, then entities decoded. */
const field = (html: string, name: string) =>
  unescapeHtml(section(html, `data-field="${name}"`, '</dd>').replace(/<[^>]*>/g, ''));

describe('event page', () => {
  it('shows a queued event: badge, "(no path)", op, received time, fingerprint, size and the job', async () => {
    const html = await eventHtml(ev.queued!);
    expect(html).toContain('data-status="queued"');
    expect(html).toContain('>Queued</span>');
    expect(field(html, 'source')).toBe('(no path)');
    expect(field(html, 'op')).toBe('write');
    expect(field(html, 'received')).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
    expect(section(html, 'data-field="received"', '</dd>')).toMatch(/<time datetime="\d{4}-\d\d-\d\dT[^"]+" title="[^"]+ UTC">/);
    expect(field(html, 'fingerprint')).toContain('fp-');
    expect(field(html, 'size')).toBe('2 bytes');
    expect(field(html, 'job')).toContain('Still queued (2 attempts so far)');
    expect(html).not.toContain('data-quarantine');
    expect(unescapeHtml(html)).toContain("This event hasn't been replayed.");
  });

  it('shows an event whose adapter is being generated', async () => {
    const html = await eventHtml(ev.generating!);
    expect(html).toContain('data-status="adapter_generating"');
    expect(html).toContain('>AI generating</span>');
    expect(field(html, 'source')).toContain('gen');
    expect(field(html, 'job')).toContain('Processed');
    expect(html).toContain('data-reason="unknown_fingerprint"');
    expect(html).toContain('No adapter handles this shape yet.');
  });

  it('shows a waiting event with the last generation failure code and "awaiting approval"', async () => {
    const html = await eventHtml(ev.waiting!);
    expect(html).toContain('data-status="waiting"');
    expect(html).toContain('>Waiting for adapter</span>');
    expect(field(html, 'adapter-failure')).toBe('invalid_output');
    expect(html).toContain('data-awaiting-approval');
    expect(html).toContain('awaiting approval');
    expect(html).not.toContain('data-replayed');
  });

  it('shows a malformed event as needing attention, in plain English', async () => {
    const html = await eventHtml(ev.quarantined!);
    expect(html).toContain('data-status="quarantined"');
    expect(html).toContain('>Needs attention</span>');
    expect(field(html, 'fingerprint')).toBe('None (malformed body)');
    expect(field(html, 'size')).toBe('8 bytes');
    expect(html).toContain('data-reason="malformed"');
    expect(unescapeHtml(html)).toContain(reasonLabel('malformed'));
    expect(html).not.toContain('data-adapter-failure');
  });

  it('shows a replayed, written event with its replay history, without replay details', async () => {
    const html = await eventHtml(ev.replayed!);
    expect(html).toContain('data-status="written"');
    expect(html).toContain('>Written</span>');
    expect(html).toContain('data-replayed');
    expect(html).not.toContain('data-awaiting-approval');
    expect(html).not.toContain('data-quarantine');
    const replays = section(html, 'data-replays', '</table>');
    expect(replays).toMatch(/2026-01-01T10:00:00.000Z[\s\S]*failed[\s\S]*2026-01-01T11:00:00.000Z[\s\S]*succeeded/);
    expect(html).not.toContain(REPLAY_DETAIL);
    expect(html).not.toContain('12345');
  });

  it('never shows the body, headers, query string or quarantine details', async () => {
    for (const id of Object.values(ev).filter((id) => id !== ev.other)) {
      const html = await eventHtml(id);
      for (const secret of [BODY_SECRET, HEADER_SECRET, QUERY_SECRET, REPLAY_DETAIL, QUARANTINE_DETAIL, 'alert(1)', 'x-signature']) {
        expect(html, `${id} ${secret}`).not.toContain(secret);
      }
    }
    const html = await eventHtml(ev.secret!);
    expect(html).toContain('View payload and headers');
    expect(html).toContain(`action="${path(ev.secret!)}/payload"`);
    expect(html).toContain(`name="_csrf" value="${member.csrf}"`);
  });

  it('returns 404 for an unknown id, a malformed id, and another account\'s event', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', `${ev.secret}x`, ev.other!]) {
      const res = await get(path(id), member);
      expect(res.status, id).toBe(404);
      expect(await res.text()).not.toContain(BODY_SECRET);
    }
  });

  it('lets a super admin view the page, but without the payload button', async () => {
    const html = await eventHtml(ev.secret!, superAdmin);
    expect(html).toContain('data-status="written"');
    expect(html).not.toContain('View payload and headers');
    expect(html).toContain('read-only access');
  });
});

describe('payload view', () => {
  const payload = (eventId: string, s: Session = member, fields: Record<string, string> = { _csrf: s.csrf }) =>
    post(`${path(eventId)}/payload`, s, fields);

  it('shows the pretty-printed body and the stored request context, escaped', async () => {
    const res = await payload(ev.secret!);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();

    const body = unescapeHtml(section(html, 'data-body', '</pre>')).trim();
    expect(body).toBe(
      JSON.stringify({ customer: BODY_SECRET, html: '<script>alert(1)</script>', n: [1, 2] }, null, 2),
    );
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('data-truncated');

    expect(field(html, 'method')).toBe('PUT');
    expect(field(html, 'path')).toBe('/ingest/hooks/x');
    expect(field(html, 'query')).toBe(`token=${QUERY_SECRET}`);
    const headers = unescapeHtml(section(html, 'data-headers', '</table>'));
    expect(headers).toContain('x-signature');
    expect(headers).toContain(HEADER_SECRET);
    expect(headers).toContain('application/json');
  });

  it('shows a non-JSON body as text, escaped', async () => {
    const html = await (await payload(ev.rawHtml!)).text();
    expect(html).not.toContain('<img');
    expect(unescapeHtml(section(html, 'data-body', '</pre>')).trim()).toBe('<img src=x onerror=alert(1)>');
    expect(field(html, 'query')).toBe('(none)');
    expect(html).toContain('No headers were stored.');
  });

  it('truncates a body over 100 KB with a notice', async () => {
    const html = await (await payload(ev.big!)).text();
    expect(html).toContain('Truncated: showing the first 102,400 of 153,600 bytes');
    const body = section(html, 'data-body', '</pre>').trim();
    expect(body).toBe('a'.repeat(100 * 1024));
  });

  it('shows a body of exactly 102400 bytes in full, with no truncation notice', async () => {
    const id = await addEvent(a, { source: 'edge', body: Buffer.alloc(PAYLOAD_LIMIT, 'a') });
    const html = await (await payload(id)).text();
    expect(html).not.toContain('data-truncated');
    expect(section(html, 'data-body', '</pre>').trim()).toBe('a'.repeat(PAYLOAD_LIMIT));
  });

  it('truncates a body of 102401 bytes with the exact byte counts', async () => {
    const id = await addEvent(a, { source: 'edge', body: Buffer.alloc(PAYLOAD_LIMIT + 1, 'a') });
    const html = await (await payload(id)).text();
    expect(html).toContain('data-truncated');
    expect(html).toContain('Truncated: showing the first 102,400 of 102,401 bytes');
    expect(section(html, 'data-body', '</pre>').trim()).toBe('a'.repeat(PAYLOAD_LIMIT));
  });

  it('notes reformatting only for a JSON body that was pretty-printed', async () => {
    const json = await (await payload(ev.secret!)).text();
    expect(json).toContain('data-reformatted');
    expect(json).toContain('Reformatted as JSON for display');
    expect(await (await payload(ev.rawHtml!)).text()).not.toContain('data-reformatted');
    expect(await (await payload(ev.big!)).text()).not.toContain('data-reformatted');
  });

  it('refuses a cross-origin POST with 403, even with a valid session and CSRF token', async () => {
    const res = await app.request(`${path(ev.secret!)}/payload`, {
      method: 'POST',
      headers: {
        ...member.headers,
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
      },
      body: new URLSearchParams({ _csrf: member.csrf }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(BODY_SECRET);
  });

  it('refuses a missing or wrong CSRF token with 403', async () => {
    expect((await payload(ev.secret!, member, {})).status).toBe(403);
    const wrong = await payload(ev.secret!, member, { _csrf: 'wrong' });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).not.toContain(BODY_SECRET);
  });

  it('refuses a super admin with 403', async () => {
    const res = await payload(ev.secret!, superAdmin);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(BODY_SECRET);
  });

  it('returns 404 for an unknown id, a malformed id, and another account\'s event', async () => {
    for (const id of [randomUUID(), 'not-a-uuid', ev.other!]) {
      const res = await payload(id);
      expect(res.status, id).toBe(404);
      expect(await res.text()).not.toContain(BODY_SECRET);
    }
  });

  it('does not answer a GET', async () => {
    expect((await get(`${path(ev.secret!)}/payload`, member)).status).toBe(404);
  });
});

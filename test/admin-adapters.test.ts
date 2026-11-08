// The admin's read-only Adapters pages: the list of shapes and one adapter's code, versions, and attempts.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createUser } from '../src/admin/users.js';
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
let member: { cookie: string };
let superAdmin: { cookie: string };
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

const get = (path: string, who = member) => app.request(path, { headers: { cookie: who.cookie } });
const page = async (path: string, who = member) => {
  const res = await get(path, who);
  expect(res.status).toBe(200);
  return res.text();
};
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
const fp = () => `fp-${randomBytes(6).toString('hex')}`;

interface AdapterOptions {
  version?: number;
  code?: string;
  active?: boolean;
  validated?: boolean;
  superseded?: boolean;
  source?: string;
  opaque?: string[];
  created?: string;
}

async function newAccount(label: string, isMember = true) {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
    [`ad-${label}-${tag}`],
  );
  const id = rows[0]!.id;
  accountIds.push(id);
  if (isMember) await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [id, memberId]);
  return {
    id,
    async adapter(fingerprint: string, o: AdapterOptions = {}): Promise<string> {
      const { rows } = await appDb.query<{ id: string }>(
        `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, active, validated_at, superseded_at, opaque_paths, created_at)
         VALUES ($1, $2, 'write', $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, CASE WHEN $8::boolean THEN now() END, $9, COALESCE($10::timestamptz, now()))
         RETURNING id`,
        [
          id,
          o.source ?? '',
          fingerprint,
          o.version ?? 1,
          o.code ?? 'export default (e) => [];',
          o.active ?? false,
          o.validated ?? false,
          o.superseded ?? false,
          o.opaque ?? [],
          o.created ?? null,
        ],
      );
      return rows[0]!.id;
    },
    attempt: (fingerprint: string, status: string, detail: string | null, startedAt: string, source = '') =>
      appDb.query(
        `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status, detail, started_at, finished_at)
         VALUES ($1, $2, 'write', $3, $4, $5, $6::timestamptz, CASE WHEN $4 = 'running' THEN NULL ELSE $6::timestamptz + interval '1 second' END)`,
        [id, source, fingerprint, status, detail, startedAt],
      ),
    event: (fingerprint: string, source = '') =>
      appDb.query(
        `INSERT INTO events (account_id, body, source, op, fingerprint, request) VALUES ($1, $2, $3, 'write', $4, '{}')`,
        [id, Buffer.from('{"card":"payload-secret"}'), source, fingerprint],
      ),
  };
}

const XSS = 'const x = "</script><b>x</b>";';
let acct: Awaited<ReturnType<typeof newAccount>>;
let other: Awaited<ReturnType<typeof newAccount>>;
const shapes = { active: fp(), awaiting: fp(), failing: fp(), generating: fp(), draft: fp() };
let activeV2: string;
let activeV1: string;
let otherAdapter: string;
const otherFp = fp();

beforeAll(async () => {
  const email = `member-${tag}@example.test`;
  memberId = (await createUser(appDb, { email, password: PASSWORD, isSuperAdmin: false })).id;
  userIds.push(memberId);
  member = await login(email);
  const adminEmail = `super-${tag}@example.test`;
  userIds.push((await createUser(appDb, { email: adminEmail, password: PASSWORD, isSuperAdmin: true })).id);
  superAdmin = await login(adminEmail);

  acct = await newAccount('main');
  // Active: v1 superseded, v2 active, with events, an extra fingerprint, and a long attempt history.
  activeV1 = await acct.adapter(shapes.active, {
    version: 1,
    validated: true,
    superseded: true,
    source: 'shopify',
    code: 'old code v1',
    created: '2026-01-01T00:00:00Z',
  });
  activeV2 = await acct.adapter(shapes.active, {
    version: 2,
    validated: true,
    active: true,
    source: 'shopify',
    code: XSS,
    opaque: ['$.items.*'],
    created: '2026-01-02T00:00:00Z',
  });
  await appDb.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [activeV2, 'extra-shape-fp']);
  await acct.event(shapes.active, 'shopify');
  await acct.event(shapes.active, 'shopify');
  await acct.event(shapes.active, 'other-source'); // a different source: not counted
  for (let i = 0; i < 25; i++) {
    const day = String(i + 1).padStart(2, '0');
    await acct.attempt(shapes.active, i % 2 ? 'succeeded' : 'failed', `code_${day}`, `2026-02-${day}T00:00:00Z`, 'shopify');
  }
  await acct.adapter(shapes.awaiting, { validated: true, source: 'stripe' });
  await acct.adapter(shapes.failing);
  await acct.attempt(shapes.failing, 'failed', 'gave_up', '2026-03-01T00:00:00Z');
  await acct.adapter(shapes.generating);
  await acct.attempt(shapes.generating, 'failed', 'old_failure', '2026-03-01T00:00:00Z');
  await acct.attempt(shapes.generating, 'running', null, '2026-03-02T00:00:00Z');
  await acct.adapter(shapes.draft);

  other = await newAccount('other', false);
  otherAdapter = await other.adapter(otherFp, { active: true, validated: true, source: 'theirs', code: 'their secret code' });
});

afterAll(async () => {
  await appDb.query(
    'DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = ANY($1))',
    [accountIds],
  );
  for (const table of ['adapter_attempts', 'adapters', 'events']) {
    await appDb.query(`DELETE FROM ${table} WHERE account_id = ANY($1)`, [accountIds]);
  }
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

const listPath = () => `/admin/accounts/${acct.id}/adapters`;

/** The visible text of the list row for this shape. */
function row(html: string, fingerprint: string): string {
  const start = html.indexOf(`title="${fingerprint}"`);
  expect(start, `row for ${fingerprint}`).toBeGreaterThan(-1);
  const from = html.lastIndexOf('<tr>', start);
  return text(html.slice(from, html.indexOf('</tr>', start)));
}

describe('adapters list', () => {
  it('shows one row per shape with its status, versions, last attempt, and event count', async () => {
    const html = await page(listPath());
    expect(text(html)).toContain('The code the AI wrote for each data shape.');
    expect(html.match(/class="row-link"/g)).toHaveLength(5);

    const active = row(html, shapes.active);
    expect(active).toContain('shopifywritefp-'); // source, op, fingerprint
    expect(active).toContain('Active');
    expect(active).toContain('v22'); // current version, then the version count
    expect(active).toContain('Failed 2026-02-25 00:00:01 UTC'); // the newest of 25 attempts
    expect(active.trim().endsWith('2')).toBe(true); // two shopify events
    expect(row(html, shapes.awaiting)).toContain('Awaiting approval');
    expect(row(html, shapes.awaiting)).toContain('None');
    expect(row(html, shapes.failing)).toContain('Failing');
    expect(row(html, shapes.failing)).toContain('Failed 2026-03-01 00:00:01 UTC');
    expect(row(html, shapes.failing)).toContain('(no path)');
    expect(row(html, shapes.generating)).toContain('Generating');
    expect(row(html, shapes.generating)).toContain('Running 2026-03-02 00:00:00 UTC');
    expect(row(html, shapes.draft)).toContain('Draft');
  });

  it('links each row to the active version, or the latest when none is active', async () => {
    const html = await page(listPath());
    expect(html).toContain(`href="${listPath()}/${activeV2}"`);
    expect(html).not.toContain(`href="${listPath()}/${activeV1}"`);
  });

  it("never shows another account's adapters, or payloads", async () => {
    const html = await page(listPath());
    expect(html).not.toContain(otherFp);
    expect(html).not.toContain('theirs');
    expect(html).not.toContain(otherAdapter);
    expect(html).not.toContain('payload-secret');
  });

  it('shows an empty state that links to Connect', async () => {
    const empty = await newAccount('empty');
    const html = await page(`/admin/accounts/${empty.id}/adapters`);
    expect(text(html)).toContain('No adapters yet');
    expect(text(html)).toContain('Send data and the AI writes one for each new shape');
    expect(html).toContain(`href="/admin/accounts/${empty.id}/connect"`);
  });
});

describe('adapter detail', () => {
  it('shows the code HTML-escaped, never as markup', async () => {
    const html = await page(`${listPath()}/${activeV2}`);
    expect(html).toContain('&lt;/script&gt;&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('</script><b>x</b>');
    expect(html).toContain('codeblock');
    expect(html).toContain('Copy');
  });

  it('shows details, the versions table with links, and extra fingerprints', async () => {
    const html = await page(`${listPath()}/${activeV2}`);
    const t = text(html);
    expect(t).toContain('shopify / write');
    expect(t).toContain('Active');
    expect(t).toContain(shapes.active);
    expect(t).toContain('Opaque paths$.items.*');
    expect(t).toContain('Also used for');
    expect(t).toContain('extra-shape-fp');
    expect(html).toContain(`href="${listPath()}/${activeV1}"`); // v1 is linked; v2 is the one being viewed
    expect(t).toContain('v2 (viewing)');
    expect(html).toContain(`<a href="${listPath()}">Adapters</a>`);
  });

  it('shows an older version on its own URL', async () => {
    const html = await page(`${listPath()}/${activeV1}`);
    expect(html).toContain('old code v1');
    expect(text(html)).toContain('Superseded');
  });

  it('lists attempts newest first, capped at 20', async () => {
    const t = text(await page(`${listPath()}/${activeV2}`));
    expect(t).toContain('code_25');
    expect(t).toContain('code_06');
    expect(t).not.toContain('code_05');
    expect(t.indexOf('code_25')).toBeLessThan(t.indexOf('code_24'));
    expect(t.indexOf('code_07')).toBeLessThan(t.indexOf('code_06'));
  });

  it('omits "Also used for" when there are no extra fingerprints', async () => {
    const { rows } = await appDb.query<{ id: string }>(
      'SELECT id FROM adapters WHERE account_id = $1 AND fingerprint = $2',
      [acct.id, shapes.draft],
    );
    const t = text(await page(`${listPath()}/${rows[0]!.id}`));
    expect(t).toContain('Draft');
    expect(t).not.toContain('Also used for');
    expect(t).toContain('No attempts recorded');
  });

  it("returns 404 for a malformed id, an unknown id, and another account's adapter", async () => {
    for (const id of ['not-a-uuid', randomUUID(), otherAdapter]) {
      const res = await get(`${listPath()}/${id}`);
      expect(res.status, id).toBe(404);
      expect(await res.text()).not.toContain('their secret code');
    }
  });
});

describe('access and navigation', () => {
  it('lets a super admin who is not a member view both pages', async () => {
    const res = await get(`/admin/accounts/${other.id}/adapters`, superAdmin);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(otherFp.slice(0, 12));
    expect((await get(`/admin/accounts/${other.id}/adapters/${otherAdapter}`, superAdmin)).status).toBe(200);
  });

  it("hides an account's adapters from a user who is not a member", async () => {
    expect((await get(`/admin/accounts/${other.id}/adapters`)).status).toBe(404);
    expect((await get(`/admin/accounts/${other.id}/adapters/${otherAdapter}`)).status).toBe(404);
  });

  it('puts Adapters after Pipeline and highlights it on both pages', async () => {
    for (const path of [listPath(), `${listPath()}/${activeV2}`]) {
      const html = await page(path);
      expect(/data-nav-key="([^"]+)" aria-current="page"/.exec(html)?.[1]).toBe('adapters');
      const keys = [...html.matchAll(/data-nav-key="([^"]+)"/g)].map((m) => m[1]);
      expect(keys.indexOf('adapters')).toBe(keys.indexOf('pipeline') + 1);
    }
  });

  it('gives the Overview card for Adapters a description', async () => {
    const html = await page(`/admin/accounts/${listPath().split('/')[3]}`);
    expect(text(html)).toContain('The code the AI wrote for each data shape.');
  });
});

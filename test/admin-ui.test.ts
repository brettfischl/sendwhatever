import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { jsx } from 'hono/jsx';
import { createUser } from '../src/admin/users.js';
import { ErrorPage } from '../src/admin/views.js';
import {
  activeNav,
  DataTable,
  EmptyState,
  pipelineStatus,
  StatusPill,
  STYLESHEET_HREF,
  type StatusVariant,
} from '../src/admin/ui/index.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { PostgresBackend } from '../src/storage/postgres/index.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const app = createApp({ appDb, backend: new PostgresBackend(), config });

const tag = randomBytes(4).toString('hex');
const PASSWORD = 'correct horse battery';
const ORIGIN = 'http://localhost';
const userIds: string[] = [];
const accountIds: string[] = [];

async function newUser(label: string, isSuperAdmin = false) {
  const email = `ui-${label}-${tag}@example.test`;
  const { id } = await createUser(appDb, { email, password: PASSWORD, isSuperAdmin });
  userIds.push(id);
  return { id, email };
}

async function newAccount(label: string) {
  const slug = `ui-${label}-${tag}`;
  const { rows } = await appDb.query<{ id: string }>(
    "INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id",
    [slug],
  );
  accountIds.push(rows[0]!.id);
  return { id: rows[0]!.id, slug };
}

async function session(email: string) {
  const res = await app.request(`${ORIGIN}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
    body: new URLSearchParams({ email, password: PASSWORD }).toString(),
  });
  expect(res.status).toBe(303);
  const cookie = /sw_admin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]!;
  return { cookie: `sw_admin=${cookie}` };
}

const page = async (path: string, headers: Record<string, string>) =>
  (await app.request(path, { headers })).text();

/** The `data-nav-key` of the item marked current, if any. */
const current = (html: string) =>
  /data-nav-key="([^"]+)" aria-current="page"/.exec(html)?.[1];

const render = async (node: unknown) => String(await (node as { toString(): unknown }).toString());

afterAll(async () => {
  await appDb.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM account_members WHERE user_id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

describe('stylesheet', () => {
  it('serves app.css publicly with a long immutable cache', async () => {
    const res = await app.request('/admin/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('cache-control')).not.toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('--accent');
  });

  it('is linked with a version query string', async () => {
    const html = await page('/admin/login', {});
    expect(STYLESHEET_HREF).toMatch(/^\/admin\/assets\/app\.css\?v=[0-9a-f]{10}$/);
    expect(html).toContain(`href="${STYLESHEET_HREF}"`);
    expect(html).not.toContain('<style');
  });

  it('serves the exact versioned URL the pages link to', async () => {
    const res = await app.request(STYLESHEET_HREF);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await (await app.request('/admin/assets/app.css')).text());
  });

  it('leaves the sidebar off logged-out pages', async () => {
    expect(await page('/admin/login', {})).not.toContain('class="sidebar"');
    const html = await render(jsx(ErrorPage, { status: 404, message: 'Page not found' }));
    expect(html).toContain('Page not found');
    expect(html).not.toContain('class="sidebar"');
  });
});

describe('sidebar', () => {
  it('shows account nav only on account pages and highlights the active item', async () => {
    const user = await newUser('member');
    const account = await newAccount('nav');
    await appDb.query('INSERT INTO account_members (account_id, user_id) VALUES ($1, $2)', [
      account.id,
      user.id,
    ]);
    const s = await session(user.email);

    const home = await page('/admin', s);
    expect(home).toContain('class="sidebar"');
    expect(home).not.toContain('data-nav="account"');
    expect(home).not.toContain('data-nav="manage"');
    expect(current(home)).toBe('accounts');

    const overview = await page(`/admin/accounts/${account.id}`, s);
    expect(overview).toContain('data-nav="account"');
    expect(overview).toContain(`data-account="${account.id}"`);
    expect(current(overview)).toBe('overview');
    expect(overview).not.toContain('data-nav="manage"');

    expect(current(await page(`/admin/accounts/${account.id}/connect`, s))).toBe('connect');
    expect(current(await page(`/admin/accounts/${account.id}/pipeline`, s))).toBe('pipeline');
    // No event pages exist yet, so this is the 404 page, but it still sits in the account's shell.
    expect(current(await page(`/admin/accounts/${account.id}/events/abc`, s))).toBe('pipeline');
  });

  it('shows the Manage section only to super admins', async () => {
    const admin = await newUser('super', true);
    const s = await session(admin.email);
    const html = await page('/admin/manage/users', s);
    expect(html).toContain('data-nav="manage"');
    expect(current(html)).toBe('manage-users');
    expect(current(await page('/admin/manage/accounts', s))).toBe('manage-accounts');
  });

  it('shows a super admin both the account nav and Manage on an account page', async () => {
    const admin = await newUser('super-acct', true);
    const account = await newAccount('super-acct');
    const html = await page(`/admin/accounts/${account.id}/schema`, await session(admin.email));
    expect(html).toContain('data-nav="account"');
    expect(html).toContain('data-nav="manage"');
    expect(current(html)).toBe('schema');
  });
});

describe('activeNav', () => {
  it('maps paths to sidebar items', () => {
    const id = '00000000-0000-0000-0000-000000000000';
    expect(activeNav('/admin')).toBe('accounts');
    expect(activeNav(`/admin/accounts/${id}`)).toBe('overview');
    expect(activeNav(`/admin/accounts/${id}/credentials/keys`)).toBe('credentials');
    expect(activeNav(`/admin/accounts/${id}/events/123`)).toBe('pipeline');
    expect(activeNav('/admin/manage/accounts/abc')).toBe('manage-accounts');
    expect(activeNav('/admin/login')).toBeUndefined();
  });
});

describe('components', () => {
  it('renders every StatusPill variant, and only progress pulses', async () => {
    const variants: StatusVariant[] = ['neutral', 'info', 'progress', 'success', 'warning', 'danger'];
    for (const variant of variants) {
      const html = await render(jsx(StatusPill, { variant }, 'Label'));
      expect(html).toContain(`class="pill pill-${variant}"`);
      expect(html).toContain('Label');
    }
    const css = await (await app.request('/admin/assets/app.css')).text();
    expect(css).toMatch(/\.pill-progress \.pill-dot \{ animation: sw-pulse/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^@]*\.pill-progress \.pill-dot \{ animation: none/);
  });

  it('maps pipeline statuses to variants and labels', () => {
    expect(pipelineStatus('queued')).toEqual({ variant: 'neutral', label: 'Queued' });
    expect(pipelineStatus('adapter_generating')).toEqual({ variant: 'progress', label: 'AI generating' });
    expect(pipelineStatus('waiting')).toEqual({ variant: 'info', label: 'Waiting for adapter' });
    expect(pipelineStatus('quarantined')).toEqual({ variant: 'warning', label: 'Needs attention' });
    expect(pipelineStatus('written')).toEqual({ variant: 'success', label: 'Written' });
    expect(pipelineStatus('something_new')).toEqual({ variant: 'neutral', label: 'something_new' });
  });

  it('renders DataTable rows, monospace columns, and the empty state', async () => {
    const columns = [
      { header: 'Name', cell: (r: { name: string; id: string }) => r.name },
      { header: 'Id', mono: true, cell: (r: { name: string; id: string }) => r.id },
    ];
    const full = await render(jsx(DataTable, { columns, rows: [{ name: 'orders', id: 'abc123' }] }));
    expect(full).toContain('<table class="data-table">');
    expect(full).toContain('<td class="mono">abc123</td>');

    const empty = await render(
      jsx(DataTable, { columns, rows: [], empty: jsx(EmptyState, { title: 'No tables yet' }) }),
    );
    expect(empty).not.toContain('<table');
    expect(empty).toContain('No tables yet');

    const fallback = await render(jsx(DataTable, { columns, rows: [] }));
    expect(fallback).toContain('Nothing here yet');
  });
});

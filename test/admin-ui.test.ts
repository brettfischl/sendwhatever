import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { jsx } from 'hono/jsx';
import { createUser } from '../src/admin/users.js';
import {
  activeNav,
  CodeBlock,
  DataTable,
  EmptyState,
  fullTime,
  KeyValueList,
  pipelineStatus,
  relativeTime,
  RelativeTime,
  Section,
  StatGrid,
  StatTile,
  StatusPill,
  Toolbar,
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
    // A cross-origin POST is refused by csrf() before any session exists, so this is the real
    // logged-out error page.
    const res = await app.request(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers: { origin: 'http://evil.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=x&password=y',
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Request refused');
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

describe('rowHref', () => {
  type Row = { name: string };
  const columns = [{ header: 'Name', cell: (r: Row) => jsx('a', { href: `/x/${r.name}` }, r.name) }];

  it('makes the row clickable and keeps a real link in the cell', async () => {
    const html = await render(
      jsx(DataTable<{ name: string }>, {
        columns,
        rows: [{ name: 'a' }],
        rowHref: (r: Row) => `/x/${r.name}`,
        rowAttrs: (r: Row) => ({ 'data-row': r.name }),
      }),
    );
    expect(html).toMatch(/<tr[^>]*class="row-link"/);
    expect(html).toContain('data-href="/x/a"');
    expect(html).toContain('data-row="a"');
    expect(html).toContain('<a href="/x/a">a</a>');
    // Clicks on inner links, buttons and form fields, and on a text selection, are left alone.
    expect(html).toContain('event.target.closest(&#39;a, button, input, select, textarea&#39;)');
    expect(html).toContain('window.getSelection()');
  });

  it('leaves rows plain without rowHref', async () => {
    const html = await render(jsx(DataTable<{ name: string }>, { columns, rows: [{ name: 'a' }] }));
    expect(html).not.toContain('row-link');
    expect(html).not.toContain('data-href');
    expect(html).not.toContain('onclick');
  });
});

describe('StatTile', () => {
  it('links, tones its number, and dims zero', async () => {
    const linked = await render(jsx(StatTile, { label: 'Waiting', value: 3, hint: 'x', tone: 'info', href: '/go' }));
    expect(linked).toMatch(/^<a class="stat stat-info" href="\/go">/);
    expect(linked).toContain('<div class="stat-value">3</div>');

    for (const tone of ['neutral', 'info', 'progress', 'success', 'warning', 'danger'] as const) {
      const html = await render(jsx(StatTile, { label: 'L', value: 1, tone }));
      expect(html).toContain(tone === 'neutral' ? 'class="stat"' : `class="stat stat-${tone}"`);
    }

    const zero = await render(jsx(StatTile, { label: 'L', value: 0, tone: 'warning', href: '/go' }));
    expect(zero).toContain('class="stat stat-zero"');
    expect(zero).not.toContain('stat-warning');
    expect(await render(jsx(StatTile, { label: 'L', value: '0' }))).toContain('stat-zero');

    expect(await render(jsx(StatTile, { label: 'L', value: 5 }))).toMatch(/^<div class="stat">/);
  });

  it('lays four tiles out as one row or 2x2, never 3+1', async () => {
    const css = await (await app.request('/admin/assets/app.css')).text();
    expect(css).toMatch(/\.stat-grid:has\(> :nth-child\(4\):last-child\) \{ grid-template-columns: repeat\(4,/);
    expect(css).toMatch(
      /max-width: 760px\) \{ \.stat-grid:has\(> :nth-child\(4\):last-child\) \{ grid-template-columns: repeat\(2,/,
    );
    expect(await render(jsx(StatGrid, {}, jsx(StatTile, { label: 'A', value: 1 })))).toContain('class="stat-grid"');
  });
});

describe('KeyValueList, Toolbar, Section, EmptyState, CodeBlock', () => {
  it('renders KeyValueList as a definition list, with optional attributes on the value', async () => {
    const html = await render(
      jsx(KeyValueList, {
        items: [
          { label: 'Source', value: 'stripe', attrs: { 'data-field': 'source' } },
          { label: 'Op', value: 'write' },
        ],
      }),
    );
    expect(html).toContain('<dl class="kv">');
    expect(html).toContain('<dt>Source</dt><dd data-field="source">stripe</dd>');
    expect(html).toContain('<dt>Op</dt><dd>write</dd>');
  });

  it('wraps Toolbar children in a labelled group', async () => {
    const html = await render(jsx(Toolbar, { label: 'Filters' }, jsx('button', {}, 'Go')));
    expect(html).toContain('class="toolbar"');
    expect(html).toContain('aria-label="Filters"');
    expect(html).toContain('<button>Go</button>');
  });

  it('renders Section header-only without a body, and compact', async () => {
    expect(await render(jsx(Section, { title: 'T' }, 'body'))).toContain('class="section-body"');
    const headerOnly = await render(jsx(Section, { title: 'T', description: 'd' }));
    expect(headerOnly).toContain('section-header-only');
    expect(headerOnly).not.toContain('section-body');
    const compact = await render(jsx(Section, { title: 'T', compact: true, flush: true }, 'x'));
    expect(compact).toContain('section-compact');
    expect(compact).toContain('section-body flush');
  });

  it('renders a compact EmptyState', async () => {
    expect(await render(jsx(EmptyState, { title: 'None', compact: true }))).toContain('class="empty empty-compact"');
    expect(await render(jsx(EmptyState, { title: 'None' }))).toContain('class="empty"');
  });

  it('gives CodeBlock a caption and a wrap or scroll mode', async () => {
    const wrapped = await render(jsx(CodeBlock, { value: 'v', label: 'thing', caption: 'Cap' }));
    expect(wrapped).toContain('<p class="codeblock-caption">Cap</p>');
    expect(wrapped).not.toContain('codeblock-scroll');
    const scroll = await render(jsx(CodeBlock, { value: 'v', label: 'thing', overflow: 'scroll' }));
    expect(scroll).toContain('codeblock-scroll');
    expect(scroll).not.toContain('codeblock-caption');
    expect(scroll).toContain('aria-label="Copy thing"');
  });
});

describe('relativeTime and fullTime', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  it('says seconds, minutes and hours', () => {
    expect(relativeTime(ago(0), now)).toBe('just now');
    expect(relativeTime(ago(4), now)).toBe('just now');
    expect(relativeTime(ago(12), now)).toBe('12s ago');
    expect(relativeTime(ago(59), now)).toBe('59s ago');
    expect(relativeTime(ago(60), now)).toBe('1m ago');
    expect(relativeTime(ago(5 * 60 + 30), now)).toBe('5m ago');
    expect(relativeTime(ago(3599), now)).toBe('59m ago');
    expect(relativeTime(ago(3600), now)).toBe('1h ago');
    expect(relativeTime(ago(23 * 3600 + 3000), now)).toBe('23h ago');
  });

  it('gives a date for older events, with the year only when it differs', () => {
    expect(relativeTime(new Date('2026-11-03T08:00:00Z'), now)).toBe('Nov 3');
    expect(relativeTime(new Date('2026-01-15T08:00:00Z'), now)).toBe('Jan 15');
    expect(relativeTime(new Date('2025-12-31T08:00:00Z'), now)).toBe('Dec 31, 2025');
  });

  it('accepts ISO strings and never goes negative for a clock-skewed future time', () => {
    expect(relativeTime('2026-11-07T11:55:00Z', now)).toBe('5m ago');
    expect(relativeTime(new Date(now.getTime() + 60_000), now)).toBe('just now');
  });

  it('formats the tooltip as UTC to the second', () => {
    expect(fullTime(new Date('2026-11-07T14:03:12.987Z'))).toBe('2026-11-07 14:03:12 UTC');
    expect(fullTime('2026-01-02T03:04:05Z')).toBe('2026-01-02 03:04:05 UTC');
  });

  it('renders RelativeTime with the full time as a tooltip', async () => {
    const html = await render(jsx(RelativeTime, { value: '2026-11-07T11:55:00Z', now }));
    expect(html).toBe('<time datetime="2026-11-07T11:55:00Z" title="2026-11-07 11:55:00 UTC">5m ago</time>');
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

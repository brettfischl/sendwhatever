// The parts of the live tables panel that need no Postgres. test/live-tables.test.ts covers the rest.
import { readFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestLog } from './ingest-client.js';
import { createDemoServer, SiteEvents } from './server.js';
import { tablesSourceFromEnv } from './tables.js';
import { Webinar } from './webinar.js';

const tracker = (await import(new URL('./public/tables-tracker.js', import.meta.url).href)) as {
  createTracker: () => {
    tables: (response: object, now: number) => any[];
    events: (response: object, now: number) => any[];
  };
  HIGHLIGHT_MS: number;
};

const LOCAL_URL = 'postgres://sw_app:secret-password@localhost:5432/sw_app';
const KEY = Buffer.alloc(32, 1).toString('base64');
const real = { mode: 'real', host: '127.0.0.1', accountSlug: 'demo' } as const;

describe('tablesSourceFromEnv', () => {
  it('shows a notice in stub mode, even with a database configured', async () => {
    const source = tablesSourceFromEnv(
      { ...real, mode: 'stub' },
      { DEMO_APP_DATABASE_URL: LOCAL_URL, SW_ENCRYPTION_KEY: KEY },
    );
    expect(await source.tables()).toMatchObject({ state: 'stub', message: expect.stringContaining('real service') });
    expect(await source.events()).toMatchObject({ state: 'stub' });
  });

  it('explains what to set when a real service has no panel settings', async () => {
    const source = tablesSourceFromEnv(real, {});
    expect(await source.tables()).toMatchObject({
      state: 'not_configured',
      message: expect.stringContaining('DEMO_APP_DATABASE_URL'),
    });
  });

  it('asks for an account when the slug header is off', async () => {
    const source = tablesSourceFromEnv(
      { ...real, accountSlug: undefined },
      { DEMO_APP_DATABASE_URL: LOCAL_URL, SW_ENCRYPTION_KEY: KEY },
    );
    expect(await source.tables()).toMatchObject({
      state: 'not_configured',
      message: expect.stringContaining('ACCOUNT_SLUG'),
    });
  });

  it.each([
    ['another host', 'postgres://sw_app:secret-password@db.example.com:5432/sw_app'],
    ['a host override in the query', `${LOCAL_URL}?host=db.example.com`],
    ['another protocol', 'http://sw_app:secret-password@localhost:5432/sw_app'],
    ['something that is not a URL', 'secret-password'],
  ])('refuses %s, without repeating the setting', (_, url) => {
    expect(() => tablesSourceFromEnv(real, { DEMO_APP_DATABASE_URL: url, SW_ENCRYPTION_KEY: KEY })).toThrow(
      /^DEMO_APP_DATABASE_URL(?!.*secret-password)/,
    );
  });

  it.each(['0.0.0.0', '192.168.1.5', 'example.com'])('refuses to show sw_app data when DEMO_HOST is %s', (host) => {
    expect(() =>
      tablesSourceFromEnv({ ...real, host }, { DEMO_APP_DATABASE_URL: LOCAL_URL, SW_ENCRYPTION_KEY: KEY }),
    ).toThrow(/DEMO_HOST/);
  });

  it.each(['127.0.0.1', 'localhost', '::1'])('allows a DEMO_HOST of %s', async (host) => {
    const source = tablesSourceFromEnv({ ...real, host }, { DEMO_APP_DATABASE_URL: LOCAL_URL, SW_ENCRYPTION_KEY: KEY });
    await source.close();
  });

  it('needs a real encryption key', () => {
    for (const SW_ENCRYPTION_KEY of [undefined, '', 'short']) {
      expect(() => tablesSourceFromEnv(real, { DEMO_APP_DATABASE_URL: LOCAL_URL, SW_ENCRYPTION_KEY })).toThrow(
        /SW_ENCRYPTION_KEY/,
      );
    }
  });
});

describe('the panel on the demo server, in stub mode', () => {
  let server: Server;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    const log = new RequestLog();
    server = createDemoServer(
      {
        webinar: new Webinar(async () => undefined as never),
        log,
        target: { mode: 'stub', url: 'http://stub', accountSlug: 'demo' },
      },
      new SiteEvents(),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers with the stub notice, not an error', async () => {
    for (const path of ['/api/tables', '/api/tables/events']) {
      const response = await fetch(`${base()}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: 'stub' });
    }
  });

  it.each([
    ['/tables', 'text/html'],
    ['/assets/console-tables.js', 'text/javascript'],
    ['/assets/tables-panel.js', 'text/javascript'],
    ['/assets/tables-panel.css', 'text/css'],
    ['/assets/tables-tracker.js', 'text/javascript'],
  ])('serves %s', async (path, type) => {
    const response = await fetch(`${base()}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
  });

  it('leaves everything else to the demo site', async () => {
    expect((await fetch(`${base()}/api/meta`)).status).toBe(200);
    expect((await fetch(`${base()}/tables/constructor`)).status).toBe(404);
    expect((await fetch(`${base()}/constructor`)).status).toBe(404);
    expect((await fetch(`${base()}/api/tables`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses a request whose Host is not loopback, so DNS rebinding cannot read it', async () => {
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        request({ port, path: '/api/tables', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end();
      });
    expect(await statusFor('evil.example')).toBe(403);
    expect(await statusFor('evil.example:3100')).toBe(403);
    expect(await statusFor(`localhost:${port}`)).toBe(200);
    expect(await statusFor(`127.0.0.1:${port}`)).toBe(200);
  });
});

describe('the panel script', () => {
  it('never builds HTML from strings, since values are client-controlled', async () => {
    for (const file of ['tables-panel.js', 'tables-tracker.js', 'console-tables.js']) {
      const source = await readFile(new URL(`./public/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/);
    }
  });
});

describe('the tracker', () => {
  const column = (name: string) => ({ name, type: 'text' });
  const row = (id: string, seq = '1', deleted = false) => ({ id, seq, deleted, values: [id] });
  const table = (name: string, columns: string[], rows: object[]) => ({
    name,
    columns: columns.map(column),
    rowCount: rows.length,
    deletedCount: 0,
    rows,
  });
  const ready = (...tables: object[]) => ({ state: 'ready', database: 'db', tables, omittedTables: 0 });

  it('treats the first response as the baseline', () => {
    const [view] = tracker.createTracker().tables(ready(table('a', ['id'], [row('1')])), 1000);
    expect(view.since).toBeNull();
    expect(view.columns[0].since).toBeNull();
    expect(view.rows[0].since).toBeNull();
  });

  it('marks new tables, columns, and rows, and keeps their first-seen time', () => {
    const t = tracker.createTracker();
    t.tables(ready(table('a', ['id'], [row('1')])), 1000);

    const views = t.tables(ready(table('a', ['id', 'email'], [row('2'), row('1')]), table('b', ['id'], [])), 2000);
    expect(views.map(({ name }) => name)).toEqual(['b', 'a']);
    const [b, a] = views;
    expect(b.since).toBe(2000);
    expect(a.since).toBeNull();
    expect(a.columns.map(({ since }: { since: number }) => since)).toEqual([null, 2000]);
    expect(a.rows.map(({ since }: { since: number }) => since)).toEqual([2000, null]);
    expect(a.countSince).toBe(2000);

    const later = t.tables(ready(table('a', ['id', 'email'], [row('2'), row('1')]), table('b', ['id'], [])), 3000);
    expect(later[0].since).toBe(2000);
  });

  it('keeps the baseline tables alphabetical', () => {
    const views = tracker.createTracker().tables(ready(table('b', ['id'], []), table('a', ['id'], [])), 1000);
    expect(views.map(({ name }) => name)).toEqual(['a', 'b']);
  });

  it('stops highlighting once the time is up', () => {
    const t = tracker.createTracker();
    t.tables(ready(), 0);
    t.tables(ready(table('a', ['id'], [row('1')])), 1000);
    const [view] = t.tables(ready(table('a', ['id'], [row('1')])), 1000 + tracker.HIGHLIGHT_MS);
    expect(view.since).toBeNull();
    expect(view.columns[0].since).toBeNull();
    expect(view.rows[0].since).toBeNull();
  });

  it('tells an update and a delete from a new row', () => {
    const t = tracker.createTracker();
    t.tables(ready(table('a', ['id'], [row('1')])), 1000);
    expect(t.tables(ready(table('a', ['id'], [row('1', '2')])), 2000)[0].rows[0]).toMatchObject({ kind: 'updated', since: 2000 });
    expect(t.tables(ready(table('a', ['id'], [row('1', '3', true)])), 3000)[0].rows[0]).toMatchObject({ kind: 'deleted', since: 3000 });
  });

  it('starts a new baseline when the store changes', () => {
    const t = tracker.createTracker();
    t.tables(ready(table('a', ['id'], [])), 1000);
    const [view] = t.tables({ ...ready(table('b', ['id'], [])), database: 'other' }, 2000);
    expect(view.since).toBeNull();
  });

  it('marks new events and status changes', () => {
    const t = tracker.createTracker();
    const event = (id: string, status: string) => ({ id, status });
    t.events({ events: [event('1', 'queued')] }, 1000);
    const views = t.events({ events: [event('2', 'queued'), event('1', 'written')] }, 2000);
    expect(views[0]).toMatchObject({ since: 2000, statusSince: null });
    expect(views[1]).toMatchObject({ since: null, statusSince: 2000 });
  });
});

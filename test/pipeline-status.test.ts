// src/pipeline/status.ts against real Postgres. Rows are seeded directly: no worker or generator runs.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  eventStatus,
  getEvent,
  getPipelineSummary,
  listRecentEvents,
  listSources,
  type EventView,
} from '../src/pipeline/status.js';

const config = loadConfig();
const appDb = new pg.Pool({ connectionString: config.appDatabaseUrl });
const accountIds: string[] = [];

afterAll(async () => {
  for (const table of ['queue', 'quarantine', 'adapter_attempts']) {
    await appDb.query(`DELETE FROM ${table} WHERE account_id = ANY($1)`, [accountIds]);
  }
  await appDb.query(
    'DELETE FROM adapter_fingerprints WHERE adapter_id IN (SELECT id FROM adapters WHERE account_id = ANY($1))',
    [accountIds],
  );
  await appDb.query('DELETE FROM adapters WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM events WHERE account_id = ANY($1)', [accountIds]);
  await appDb.query('DELETE FROM accounts WHERE id = ANY($1)', [accountIds]);
  await appDb.end();
});

const fp = () => `fp-${randomBytes(4).toString('hex')}`;

/** One account and helpers that seed its rows. */
async function seedAccount() {
  const { rows } = await appDb.query<{ id: string }>(
    `INSERT INTO accounts (slug, status) VALUES ($1, 'active') RETURNING id`,
    [`ps-${randomBytes(5).toString('hex')}`],
  );
  const id = rows[0]!.id;
  accountIds.push(id);
  return {
    id,
    async event(fingerprint: string | null, source = '', op: 'write' | 'delete' = 'write'): Promise<string> {
      const { rows } = await appDb.query<{ id: string }>(
        `INSERT INTO events (account_id, body, source, op, fingerprint, request)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, Buffer.from('{"secret":"payload-value"}'), source, op, fingerprint, { headers: { 'x-secret': 'header-value' } }],
      );
      return rows[0]!.id;
    },
    job: (eventId: string, attempts = 0) =>
      appDb.query(`INSERT INTO queue (account_id, kind, event_id, attempts) VALUES ($1, 'ingest', $2, $3)`, [
        id,
        eventId,
        attempts,
      ]),
    quarantine: (eventId: string, reason: string, opts: { detail?: string; released?: boolean; secondsAgo?: number } = {}) =>
      appDb.query(
        `INSERT INTO quarantine (event_id, account_id, reason, detail, released_at, quarantined_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END, now() - make_interval(secs => $6))`,
        [eventId, id, reason, opts.detail ?? null, opts.released ?? false, opts.secondsAgo ?? 0],
      ),
    attempt: (
      fingerprint: string,
      status: 'running' | 'succeeded' | 'failed',
      opts: { detail?: string; source?: string; op?: string; hoursAgo?: number } = {},
    ) =>
      appDb.query(
        `INSERT INTO adapter_attempts (account_id, source, op, fingerprint, status, detail, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(hours => $7),
                 CASE WHEN $5 = 'running' THEN NULL ELSE now() - make_interval(hours => $7) END)`,
        [id, opts.source ?? '', opts.op ?? 'write', fingerprint, status, opts.detail ?? null, opts.hoursAgo ?? 0],
      ),
    async adapter(
      fingerprint: string,
      opts: { validated?: boolean; active?: boolean; superseded?: boolean; source?: string; version?: number } = {},
    ): Promise<string> {
      const { rows } = await appDb.query<{ id: string }>(
        `INSERT INTO adapters (account_id, source, op, fingerprint, version, code, active, validated_at, superseded_at)
         VALUES ($1, $2, 'write', $3, $4, '', $5, CASE WHEN $6 THEN now() END, CASE WHEN $7 THEN now() END)
         RETURNING id`,
        [
          id,
          opts.source ?? '',
          fingerprint,
          opts.version ?? 1,
          opts.active ?? false,
          opts.validated ?? true,
          opts.superseded ?? false,
        ],
      );
      return rows[0]!.id;
    },
  };
}

type Seeded = Awaited<ReturnType<typeof seedAccount>>;

async function view(account: Seeded, eventId: string): Promise<EventView> {
  const event = await getEvent(appDb, account.id, eventId);
  if (!event) throw new Error(`No event ${eventId}`);
  return event;
}

describe('eventStatus', () => {
  const row = (attempts: number | null, reasons: string[], attempt_status: string | null = null) =>
    eventStatus({ attempts, quarantine: reasons.map((reason) => ({ reason })), attempt_status });

  it('matches the demo console', () => {
    expect(row(0, [])).toBe('queued');
    expect(row(2, ['write_error'])).toBe('queued');
    expect(row(null, [])).toBe('written');
    expect(row(null, ['unknown_fingerprint'])).toBe('waiting');
    expect(row(null, ['unknown_fingerprint'], 'failed')).toBe('waiting');
    expect(row(null, ['unknown_fingerprint'], 'running')).toBe('adapter_generating');
    expect(row(null, ['adapter_error'], 'running')).toBe('adapter_generating');
    expect(row(null, ['schema_conflict'], 'running')).toBe('adapter_generating');
    expect(row(null, ['write_error'], 'running')).toBe('quarantined');
    expect(row(null, ['malformed'])).toBe('quarantined');
    expect(row(null, ['adapter_error'])).toBe('quarantined');
  });
});

describe('event views', () => {
  it('computes every status from the rows', async () => {
    const acct = await seedAccount();
    const queued = await acct.event(fp());
    await acct.job(queued, 3);
    expect(await view(acct, queued)).toMatchObject({ status: 'queued', attempts: 3 });

    const written = await acct.event(fp(), 'shopify');
    expect(await view(acct, written)).toMatchObject({
      status: 'written',
      attempts: null,
      replayed: false,
      quarantine: [],
      source: 'shopify',
    });

    const malformed = await acct.event(null);
    await acct.quarantine(malformed, 'malformed', { detail: 'Not an object or array' });
    expect(await view(acct, malformed)).toMatchObject({
      status: 'quarantined',
      fingerprint: null,
      quarantine: [{ reason: 'malformed', detail: 'Not an object or array' }],
    });

    const shape = fp();
    const waiting = await acct.event(shape);
    await acct.quarantine(waiting, 'unknown_fingerprint', { detail: 'no_active_adapter' });
    expect(await view(acct, waiting)).toMatchObject({ status: 'waiting', adapterFailure: null });

    await acct.attempt(shape, 'running');
    expect((await view(acct, waiting)).status).toBe('adapter_generating');

    await appDb.query(
      `UPDATE adapter_attempts SET status = 'failed', detail = 'gave_up', finished_at = now()
        WHERE account_id = $1 AND fingerprint = $2`,
      [acct.id, shape],
    );
    expect(await view(acct, waiting)).toMatchObject({ status: 'waiting', adapterFailure: 'gave_up' });

    const adapterId = await acct.adapter(shape, { active: true });
    await appDb.query('UPDATE quarantine SET released_at = now(), released_by_adapter_id = $2 WHERE event_id = $1', [
      waiting,
      adapterId,
    ]);
    expect(await view(acct, waiting)).toMatchObject({ status: 'written', replayed: true, quarantine: [] });
  });

  it('only matches a generation for the same source', async () => {
    const acct = await seedAccount();
    const shape = fp();
    const eventId = await acct.event(shape);
    await acct.quarantine(eventId, 'unknown_fingerprint');
    await acct.attempt(shape, 'running', { source: 'elsewhere' });
    expect((await view(acct, eventId)).status).toBe('waiting');
  });

  it('flags awaitingApproval only for a validated, inactive, current adapter of the same shape', async () => {
    const acct = await seedAccount();
    const flagged = async (setup: (shape: string) => Promise<unknown>) => {
      const shape = fp();
      const eventId = await acct.event(shape);
      await acct.quarantine(eventId, 'unknown_fingerprint');
      await setup(shape);
      return (await view(acct, eventId)).awaitingApproval;
    };
    expect(await flagged(async () => {})).toBe(false);
    expect(await flagged((shape) => acct.adapter(shape))).toBe(true);
    expect(await flagged((shape) => acct.adapter(shape, { validated: false }))).toBe(false);
    expect(await flagged((shape) => acct.adapter(shape, { active: true }))).toBe(false);
    expect(await flagged((shape) => acct.adapter(shape, { superseded: true }))).toBe(false);
    expect(await flagged((shape) => acct.adapter(shape, { source: 'elsewhere' }))).toBe(false);
    // An adapter that passed validation for further shapes (§12.1) counts for them too.
    expect(
      await flagged(async (shape) => {
        const adapterId = await acct.adapter(fp());
        await appDb.query('INSERT INTO adapter_fingerprints (adapter_id, fingerprint) VALUES ($1, $2)', [adapterId, shape]);
      }),
    ).toBe(true);
  });

  it('lists newest first, defaults to 25, and caps the limit at 100', async () => {
    const acct = await seedAccount();
    const ids: string[] = [];
    for (let i = 0; i < 105; i++) ids.push(await acct.event(fp()));
    const newest = ids.slice().reverse();
    expect((await listRecentEvents(appDb, { accountId: acct.id })).map((e) => e.id)).toEqual(newest.slice(0, 25));
    expect((await listRecentEvents(appDb, { accountId: acct.id, limit: 3 })).map((e) => e.id)).toEqual(newest.slice(0, 3));
    expect(await listRecentEvents(appDb, { accountId: acct.id, limit: 1000 })).toHaveLength(100);
    expect(await listRecentEvents(appDb, { accountId: acct.id, limit: 0 })).toHaveLength(1);
  });

  it('filters by source, including events with no path', async () => {
    const acct = await seedAccount();
    const shop = await acct.event(fp(), 'shopify');
    const bare = await acct.event(fp(), '');
    await acct.event(fp(), 'stripe');
    expect((await listRecentEvents(appDb, { accountId: acct.id, source: 'shopify' })).map((e) => e.id)).toEqual([shop]);
    expect((await listRecentEvents(appDb, { accountId: acct.id, source: '' })).map((e) => e.id)).toEqual([bare]);
    expect(await listRecentEvents(appDb, { accountId: acct.id, source: 'nope' })).toEqual([]);
  });

  it('filters by computed status, reaching past newer events of other statuses', async () => {
    const acct = await seedAccount();
    const generatingShape = fp();
    const generating = await acct.event(generatingShape);
    await acct.quarantine(generating, 'unknown_fingerprint');
    await acct.attempt(generatingShape, 'running');

    const waiting = await acct.event(fp(), 'shopify');
    await acct.quarantine(waiting, 'unknown_fingerprint');

    const writeErrorShape = fp();
    const quarantined = await acct.event(writeErrorShape);
    await acct.quarantine(quarantined, 'write_error', { detail: 'down' });
    await acct.attempt(writeErrorShape, 'running'); // the generator leaves write_error alone

    const queued = await acct.event(fp());
    await acct.job(queued);

    const written: string[] = [];
    for (let i = 0; i < 30; i++) written.push(await acct.event(fp()));

    const ids = async (status: EventView['status'], extra: { source?: string; limit?: number } = {}) =>
      (await listRecentEvents(appDb, { accountId: acct.id, status, ...extra })).map((e) => e.id);
    expect(await ids('adapter_generating')).toEqual([generating]);
    expect(await ids('waiting')).toEqual([waiting]);
    expect(await ids('quarantined')).toEqual([quarantined]);
    expect(await ids('queued')).toEqual([queued]);
    expect(await ids('written', { limit: 5 })).toEqual(written.slice(-5).reverse());
    expect(await ids('waiting', { source: 'shopify' })).toEqual([waiting]);
    expect(await ids('waiting', { source: 'stripe' })).toEqual([]);
    for (const event of await listRecentEvents(appDb, { accountId: acct.id, status: 'written', limit: 100 })) {
      expect(event.status).toBe('written');
    }
  });

  it('getEvent returns null for another account, an unknown id, or something that is not a UUID', async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const eventId = await theirs.event(fp());
    expect(await getEvent(appDb, theirs.id, eventId)).toMatchObject({ id: eventId });
    expect(await getEvent(appDb, mine.id, eventId)).toBeNull();
    expect(await getEvent(appDb, mine.id, randomUUID())).toBeNull();
    expect(await getEvent(appDb, mine.id, "'; DROP TABLE events; --")).toBeNull();
  });

  it('never returns payloads or request headers, and cuts a long detail', async () => {
    const acct = await seedAccount();
    const eventId = await acct.event(fp());
    await acct.quarantine(eventId, 'adapter_error', { detail: 'd'.repeat(1000) });
    const event = await view(acct, eventId);
    expect(event.quarantine[0]!.detail).toHaveLength(300);
    const text = JSON.stringify(await listRecentEvents(appDb, { accountId: acct.id }));
    expect(text).not.toContain('payload-value');
    expect(text).not.toContain('header-value');
    expect(Object.keys(event).sort()).toEqual(
      [
        'adapterFailure',
        'attempts',
        'awaitingApproval',
        'fingerprint',
        'id',
        'op',
        'quarantine',
        'receivedAt',
        'replayed',
        'seq',
        'source',
        'status',
      ].sort(),
    );
  });
});

describe('listSources', () => {
  it('lists distinct sources, the empty one included, and only for the account', async () => {
    const acct = await seedAccount();
    const other = await seedAccount();
    await acct.event(fp(), 'stripe');
    await acct.event(fp(), 'shopify');
    await acct.event(fp(), 'shopify');
    await acct.event(fp(), '');
    await other.event(fp(), 'theirs');
    expect(await listSources(appDb, acct.id)).toEqual(['', 'shopify', 'stripe']);
    expect(await listSources(appDb, (await seedAccount()).id)).toEqual([]);
  });
});

describe('getPipelineSummary', () => {
  it('is all zeros for a quiet account', async () => {
    const acct = await seedAccount();
    await acct.event(fp());
    expect(await getPipelineSummary(appDb, acct.id)).toEqual({
      quarantineByReason: [],
      waitingEvents: 0,
      waitingShapeCount: 0,
      waitingShapes: [],
      generationsRunning: 0,
      lastFailure: null,
      awaitingApproval: 0,
    });
  });

  it('counts open quarantine, waiting shapes, generations, the last failure, and approvals', async () => {
    const acct = await seedAccount();
    const big = fp();
    const small = fp();
    for (let i = 0; i < 3; i++) {
      await acct.quarantine(await acct.event(big, 'shopify'), 'unknown_fingerprint', { secondsAgo: 100 - i });
    }
    await acct.quarantine(await acct.event(small, ''), 'unknown_fingerprint', { secondsAgo: 10 });
    // Released rows don't count.
    await acct.quarantine(await acct.event(fp()), 'unknown_fingerprint', { released: true });
    await acct.quarantine(await acct.event(fp()), 'write_error', { released: true });
    await acct.quarantine(await acct.event(null), 'malformed');
    await acct.quarantine(await acct.event(fp()), 'write_error');
    await acct.quarantine(await acct.event(fp()), 'write_error');

    await acct.attempt(big, 'running', { source: 'shopify' });
    await acct.attempt(fp(), 'failed', { detail: 'too_old', hoursAgo: 30 }); // outside 24 hours
    await acct.attempt(fp(), 'failed', { detail: 'older', source: 'stripe', hoursAgo: 2 });
    await acct.attempt(fp(), 'failed', { detail: 'gave_up', source: 'shopify', op: 'delete', hoursAgo: 1 });
    await acct.attempt(fp(), 'succeeded');

    await acct.adapter(fp()); // awaiting approval
    await acct.adapter(fp()); // awaiting approval
    await acct.adapter(fp(), { active: true });
    await acct.adapter(fp(), { superseded: true });
    await acct.adapter(fp(), { validated: false });

    const summary = await getPipelineSummary(appDb, acct.id);
    expect(summary.quarantineByReason).toEqual([
      { reason: 'unknown_fingerprint', count: 4 },
      { reason: 'write_error', count: 2 },
      { reason: 'malformed', count: 1 },
    ]);
    expect(summary.waitingEvents).toBe(4);
    expect(summary.waitingShapeCount).toBe(2);
    expect(summary.waitingShapes).toEqual([
      { source: 'shopify', op: 'write', fingerprint: big, events: 3, oldestQuarantinedAt: expect.any(String) },
      { source: '', op: 'write', fingerprint: small, events: 1, oldestQuarantinedAt: expect.any(String) },
    ]);
    const age = Date.now() - Date.parse(summary.waitingShapes[0]!.oldestQuarantinedAt);
    expect(age).toBeGreaterThanOrEqual(99_000);
    expect(summary.generationsRunning).toBe(1);
    expect(summary.lastFailure).toEqual({
      source: 'shopify',
      op: 'delete',
      detail: 'gave_up',
      finishedAt: expect.any(String),
    });
    expect(summary.awaitingApproval).toBe(2);
  });

  it('shows at most 10 waiting shapes, and counts them all', async () => {
    const acct = await seedAccount();
    for (let i = 0; i < 12; i++) await acct.quarantine(await acct.event(fp()), 'unknown_fingerprint');
    const summary = await getPipelineSummary(appDb, acct.id);
    expect(summary.waitingShapes).toHaveLength(10);
    expect(summary.waitingShapeCount).toBe(12);
    expect(summary.waitingEvents).toBe(12);
  });
});

describe('account isolation', () => {
  it("never shows another account's events, quarantine, attempts, or adapters", async () => {
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const shape = fp();
    // The same shape in both accounts: their generation must not make my event "generating".
    const myEvent = await mine.event(shape);
    await mine.quarantine(myEvent, 'unknown_fingerprint');
    const theirEvent = await theirs.event(shape);
    await theirs.quarantine(theirEvent, 'unknown_fingerprint');
    await theirs.quarantine(await theirs.event(null), 'malformed');
    await theirs.attempt(shape, 'running');
    await theirs.attempt(fp(), 'failed', { detail: 'theirs' });
    await theirs.adapter(shape);

    const events = await listRecentEvents(appDb, { accountId: mine.id });
    expect(events.map((e) => e.id)).toEqual([myEvent]);
    expect(events[0]).toMatchObject({ status: 'waiting', awaitingApproval: false, adapterFailure: null });
    expect(await getPipelineSummary(appDb, mine.id)).toMatchObject({
      quarantineByReason: [{ reason: 'unknown_fingerprint', count: 1 }],
      waitingEvents: 1,
      generationsRunning: 0,
      lastFailure: null,
      awaitingApproval: 0,
    });
  });
});

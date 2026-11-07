// The live tables panel's server side (PRD §20). Local demo only.
//
// There are two connections, and neither is reachable from the browser. Table contents come through the
// store's read-only login, to that store's own database (§14.1). Event progress comes from `sw_app`,
// which customers can't reach, so it's only allowed when the demo server itself stays on loopback.
import type { IncomingMessage } from 'node:http';
import pg from 'pg';
import { decryptJson } from '../src/secrets.js';
import { HttpError } from './http.js';

const quote = pg.escapeIdentifier;

const MAX_TABLES = 40;
const RECENT_ROWS = 5;
const RECENT_EVENTS = 12;
/** A payload can hold a megabyte in one value, and every viewer polls. */
const MAX_VALUE_LENGTH = 200;
const MAX_DETAIL_LENGTH = 300;

const CONNECT_TIMEOUT_MS = 3_000;
const STATEMENT_TIMEOUT_MS = 5_000;
/** A read that waits on a worker's `ALTER TABLE` holds up everything queued behind it (§14.1). */
const LOCK_TIMEOUT_MS = 2_000;
const POOL_IDLE_TIMEOUT_MS = 10_000;
const POOL_MAX_CONNECTIONS = 2;
const CLIENT_TIMEOUT_MARGIN_MS = 1_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Quarantine reasons the adapter generator works on (§12.1). The others are left to operators. */
const GENERATOR_REASONS = new Set(['unknown_fingerprint', 'adapter_error', 'schema_conflict']);

export type PanelState =
  /** The demo is sending to the built-in stub, which stores nothing. */
  | 'stub'
  /** A real service, but the panel hasn't been given a way to read it. */
  | 'not_configured'
  /** The account has no store the panel can read yet. */
  | 'no_store'
  /** Reading failed. The details are in the server log, and never reach the browser. */
  | 'unavailable';

export interface PanelNotice {
  state: PanelState;
  message: string;
}

export interface ColumnView {
  name: string;
  type: string;
}

export interface RowView {
  /** The `id` column, or null for a table the platform didn't create. */
  id: string | null;
  /** The `_event_seq` column, which changes when a later event merges into the row. */
  seq: string | null;
  deleted: boolean;
  /** One per column, in column order. Everything is text so nothing depends on JSON's number range. */
  values: (string | null)[];
}

export interface TableView {
  name: string;
  columns: ColumnView[];
  rowCount: number;
  deletedCount: number;
  /** Newest first. */
  rows: RowView[];
}

export type TablesResponse =
  | PanelNotice
  | { state: 'ready'; database: string; tables: TableView[]; omittedTables: number };

export type EventStatus = 'queued' | 'adapter_generating' | 'waiting' | 'quarantined' | 'written';

export interface EventView {
  id: string;
  seq: string;
  source: string;
  op: string;
  fingerprint: string | null;
  receivedAt: string;
  status: EventStatus;
  /** Claims so far, while queued. The queue can't tell a running job from one in backoff. */
  attempts: number | null;
  /** Open quarantine rows. An event can have one per store (§10). */
  quarantine: { reason: string; detail: string | null }[];
  /** Why the last generation for this shape failed, if it did. */
  adapterFailure: string | null;
  /** It reached `written` through a replay, after being quarantined. */
  replayed: boolean;
}

export type EventsResponse = PanelNotice | { state: 'ready'; events: EventView[] };

export interface TablesSource {
  tables(): Promise<TablesResponse>;
  events(): Promise<EventsResponse>;
  close(): Promise<void>;
}

export interface TablesConfig {
  appDatabaseUrl: string;
  encryptionKey: Buffer;
  accountSlug: string;
}

/** A source that always shows the same notice, for when there's nothing to read. */
export function noticeSource(notice: PanelNotice): TablesSource {
  return { tables: async () => notice, events: async () => notice, close: async () => {} };
}

const STUB_NOTICE: PanelNotice = {
  state: 'stub',
  message:
    'The demo is sending to the built-in stub, which stores nothing. Connect a real service to watch tables appear: set INGEST_URL, INGEST_API_KEY, and DEMO_APP_DATABASE_URL, then restart.',
};

export const stubSource = (): TablesSource => noticeSource(STUB_NOTICE);

/** Picks the source for how the demo is running. Throws at startup on a setting that isn't safe. */
export function tablesSourceFromEnv(
  { mode, host, accountSlug }: { mode: 'stub' | 'real'; host: string; accountSlug: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): TablesSource {
  if (mode === 'stub') return stubSource();
  const appDatabaseUrl = env.DEMO_APP_DATABASE_URL;
  if (!appDatabaseUrl) {
    return noticeSource({
      state: 'not_configured',
      message: 'Connected to a real service, but the panel can\'t read it. Set DEMO_APP_DATABASE_URL and SW_ENCRYPTION_KEY, then restart.',
    });
  }
  assertLocalOnly(appDatabaseUrl, host);
  if (!accountSlug) {
    return noticeSource({
      state: 'not_configured',
      message: 'The panel needs to know which account to show. Set ACCOUNT_SLUG, then restart.',
    });
  }
  const encryptionKey = Buffer.from(env.SW_ENCRYPTION_KEY ?? '', 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('DEMO_APP_DATABASE_URL is set, so SW_ENCRYPTION_KEY must be set too: 32 bytes, base64 encoded.');
  }
  return createTablesSource({ appDatabaseUrl, encryptionKey, accountSlug });
}

/** Messages name the setting and never echo its value, which holds a password. */
function assertLocalOnly(appDatabaseUrl: string, demoHost: string): void {
  let url: URL;
  try {
    url = new URL(appDatabaseUrl);
  } catch {
    throw new Error('DEMO_APP_DATABASE_URL is not a valid URL.');
  }
  // A query can override the host, as in ?host=db.example.com.
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname) || url.search) {
    throw new Error('DEMO_APP_DATABASE_URL must be a postgres:// URL on localhost, with no query.');
  }
  const host = demoHost.includes(':') ? `[${demoHost}]` : demoHost;
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('DEMO_APP_DATABASE_URL shows application data, so DEMO_HOST must stay on loopback.');
  }
}

/** The panel's routes show payloads and `sw_app` data. Checking Host stops DNS rebinding reaching them. */
export function assertLoopbackRequest(req: IncomingMessage): void {
  let hostname: string | undefined;
  try {
    hostname = new URL(`http://${req.headers.host}`).hostname;
  } catch {
    // Not a host at all, which fails the check below.
  }
  if (!hostname || !LOOPBACK_HOSTS.has(hostname)) {
    throw new HttpError(403, 'this panel is only available on loopback');
  }
}

/** Overlapping polls share one read, however many viewers there are. */
function coalesce<T>(read: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    running ??= read().finally(() => {
      running = undefined;
    });
    return running;
  };
}

interface StoreRow {
  backend: string;
  connection: Record<string, unknown>;
  read_credentials: Buffer | null;
}

interface StoreLogin {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function createTablesSource(config: TablesConfig): TablesSource {
  const appDb = new pg.Pool({
    connectionString: config.appDatabaseUrl,
    application_name: 'sw-demo-tables-app',
    // The panel only ever reads, on a role that could do far more.
    options: '-c default_transaction_read_only=on',
    max: POOL_MAX_CONNECTIONS,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
  });
  // Without a listener, a dropped idle connection would crash the process.
  appDb.on('error', () => {});

  let storePool: { key: string; pool: pg.Pool } | undefined;

  /** One pool at a time. A rebuild or a new password changes the login, and the old pool goes. */
  function poolFor(login: StoreLogin): pg.Pool {
    const key = JSON.stringify(login);
    if (storePool?.key === key) return storePool.pool;
    storePool?.pool.end().catch(() => {});
    const pool = new pg.Pool({
      ...login,
      application_name: 'sw-demo-tables-store',
      max: POOL_MAX_CONNECTIONS,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      query_timeout: STATEMENT_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS,
    });
    pool.on('error', () => {});
    storePool = { key, pool };
    return pool;
  }

  /** Read for every poll, so a rebuild's new store shows up without a restart. */
  async function loadLogin(): Promise<StoreLogin | PanelNotice> {
    const { rows } = await appDb.query<StoreRow>(
      `SELECT s.backend, s.connection, s.read_credentials
       FROM account_stores s JOIN accounts a ON a.id = s.account_id
       WHERE a.slug = $1 AND s.status = 'active'`,
      [config.accountSlug],
    );
    const store = rows[0];
    if (!store?.read_credentials) {
      return {
        state: 'no_store',
        message: `Account "${config.accountSlug}" has no active store yet. Create it, then its tables appear here.`,
      };
    }
    if (store.backend !== 'postgres') {
      return { state: 'no_store', message: 'This panel can only read Postgres stores.' };
    }
    return toLogin(store.connection, decryptJson(config.encryptionKey, store.read_credentials));
  }

  /** Any failure becomes a fixed message: pg errors name hosts and users, and this reaches the browser. */
  async function guarded<T>(read: () => Promise<T>): Promise<T | PanelNotice> {
    try {
      return await read();
    } catch (error) {
      console.error('tables panel: read failed:', (error as Error).message);
      return { state: 'unavailable', message: 'Can\'t read the store right now. Retrying.' };
    }
  }

  return {
    tables: coalesce(() =>
      guarded<TablesResponse>(async () => {
        const login = await loadLogin();
        if ('state' in login) return login;
        return { state: 'ready', database: login.database, ...(await readTables(poolFor(login))) };
      }),
    ),
    events: coalesce(() =>
      guarded<EventsResponse>(async () => ({
        state: 'ready',
        events: await readEvents(appDb, config.accountSlug),
      })),
    ),
    close: async () => {
      await Promise.all([appDb.end(), storePool?.pool.end()]);
    },
  };
}

/**
 * `connection.database` is where `provision` runs, not the store. The login's own `database` is the
 * only one it can reach. pg falls back to PG* variables for anything missing, which could silently
 * reach the wrong server, so nothing here is optional.
 */
function toLogin(connection: Record<string, unknown>, credentials: Record<string, unknown>): StoreLogin {
  const { host, port } = connection;
  const { database, user, password } = credentials;
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof database !== 'string' ||
    typeof user !== 'string' ||
    typeof password !== 'string'
  ) {
    throw new Error('The store is missing connection or read-only login settings');
  }
  return { host, port, database, user, password };
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

/**
 * Separate statements rather than one transaction, so no table stays locked while the next is read: a
 * worker's `ALTER TABLE` would wait on it. A count can be a row off from its rows until the next poll.
 */
async function readTables(pool: pg.Pool): Promise<{ tables: TableView[]; omittedTables: number }> {
  const client = await pool.connect();
  try {
    // information_schema only lists what this login can read.
    const { rows } = await client.query<ColumnRow>(
      `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`,
    );
    const byTable = new Map<string, ColumnView[]>();
    for (const row of rows) {
      const columns = byTable.get(row.table_name) ?? [];
      columns.push({ name: row.column_name, type: row.data_type });
      byTable.set(row.table_name, columns);
    }

    const tables: TableView[] = [];
    for (const [name, columns] of [...byTable].slice(0, MAX_TABLES)) {
      tables.push(await readTable(client, name, columns));
    }
    return { tables, omittedTables: Math.max(0, byTable.size - MAX_TABLES) };
  } finally {
    client.release();
  }
}

async function readTable(client: pg.PoolClient, name: string, columns: ColumnView[]): Promise<TableView> {
  const target = `"public".${quote(name)}`;
  const position = (column: string) => columns.findIndex((candidate) => candidate.name === column);
  const idAt = position('id');
  const seqAt = position('_event_seq');
  const deletedAt = position('_deleted_at');

  const counts = await client.query<{ total: string; deleted: string }>(
    `SELECT count(*) AS total, ${deletedAt < 0 ? '0' : 'count(*) FILTER (WHERE "_deleted_at" IS NOT NULL)'} AS deleted
     FROM ${target}`,
  );

  const order = [seqAt >= 0 && '"_event_seq" DESC', idAt >= 0 && '"id" DESC'].filter(Boolean);
  // Text keeps BIGINT and NUMERIC exact. One extra character shows when a value was cut.
  const list = columns.map(({ name: column }) => `left(${quote(column)}::text, ${MAX_VALUE_LENGTH + 1})`);
  // Arrays, not objects: a column can be called __proto__, and values line up with `columns` either way.
  const recent = await client.query<(string | null)[]>({
    text: `SELECT ${list.join(', ')} FROM ${target}
      ${order.length > 0 ? `ORDER BY ${order.join(', ')}` : ''} LIMIT ${RECENT_ROWS}`,
    rowMode: 'array',
  });

  return {
    name,
    columns,
    rowCount: Number(counts.rows[0]?.total),
    deletedCount: Number(counts.rows[0]?.deleted),
    rows: recent.rows.map((row) => ({
      id: row[idAt] ?? null,
      seq: row[seqAt] ?? null,
      deleted: (row[deletedAt] ?? null) !== null,
      values: row.map(shorten),
    })),
  };
}

function shorten(value: string | null): string | null {
  return value !== null && value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

interface EventRow {
  id: string;
  seq: string;
  source: string;
  op: string;
  fingerprint: string | null;
  received_at: Date;
  attempts: number | null;
  quarantine: { reason: string; detail: string | null }[];
  replayed: boolean;
  attempt_status: string | null;
  attempt_detail: string | null;
}

/**
 * One statement, so one snapshot. An event and its job commit together (§5.1), and a job is deleted in
 * the same transaction that quarantines it (§5.2), so no event can be seen between those states.
 *
 * Never reads `body` or `request`, which hold what the client sent. `adapter_attempts` is matched on
 * the event's own fingerprint.
 */
async function readEvents(appDb: pg.Pool, accountSlug: string): Promise<EventView[]> {
  const { rows } = await appDb.query<EventRow>(
    `SELECT e.id, e.seq::text AS seq, e.source, e.op, e.fingerprint, e.received_at,
       j.attempts,
       COALESCE(q.open, '[]') AS quarantine,
       COALESCE(q.replayed, false) AS replayed,
       a.status AS attempt_status, left(a.detail, $3) AS attempt_detail
     FROM (
       SELECT e.id, e.seq, e.account_id, e.source, e.op, e.fingerprint, e.received_at
       FROM events e JOIN accounts acct ON acct.id = e.account_id
       WHERE acct.slug = $1
       ORDER BY e.seq DESC
       LIMIT $2
     ) e
     LEFT JOIN queue j ON j.kind = 'ingest' AND j.event_id = e.id
     LEFT JOIN LATERAL (
       SELECT
         jsonb_agg(jsonb_build_object('reason', r.reason, 'detail', left(r.detail, $3)) ORDER BY r.quarantined_at)
           FILTER (WHERE r.released_at IS NULL) AS open,
         bool_or(r.released_by_adapter_id IS NOT NULL) AS replayed
       FROM quarantine r
       WHERE r.account_id = e.account_id AND r.event_id = e.id
     ) q ON true
     LEFT JOIN LATERAL (
       SELECT t.status, t.detail FROM adapter_attempts t
       WHERE t.account_id = e.account_id AND t.source = e.source AND t.op = e.op AND t.fingerprint = e.fingerprint
       ORDER BY t.started_at DESC
       LIMIT 1
     ) a ON true
     ORDER BY e.seq DESC`,
    [accountSlug, RECENT_EVENTS, MAX_DETAIL_LENGTH],
  );

  return rows.map((row) => ({
    id: row.id,
    seq: row.seq,
    source: row.source,
    op: row.op,
    fingerprint: row.fingerprint,
    receivedAt: row.received_at.toISOString(),
    status: eventStatus(row),
    attempts: row.attempts,
    quarantine: row.quarantine,
    adapterFailure: row.attempt_status === 'failed' ? row.attempt_detail : null,
    replayed: row.replayed && row.quarantine.length === 0,
  }));
}

/**
 * `written` means the job is gone and no quarantine row is open. That's all the schema records: a job
 * whose adapter returned no rows finishes the same way (§10.1), so it can also mean "nothing to write".
 */
function eventStatus(row: Pick<EventRow, 'attempts' | 'quarantine' | 'attempt_status'>): EventStatus {
  if (row.attempts !== null) return 'queued';
  if (row.quarantine.length === 0) return 'written';
  const reasons = row.quarantine.map(({ reason }) => reason);
  if (row.attempt_status === 'running' && reasons.some((reason) => GENERATOR_REASONS.has(reason))) {
    return 'adapter_generating';
  }
  return reasons.includes('unknown_fingerprint') ? 'waiting' : 'quarantined';
}

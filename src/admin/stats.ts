import pg from 'pg';
import { decryptJson } from '../secrets.js';

/** Read-only queries behind the admin's Schema, Traffic and Pipeline pages. Every query is scoped to one account. */

export interface ActiveStore {
  id: string;
  namespace: string;
  connection: Record<string, unknown>;
  credentials: Buffer | null;
}

/** The account's active store (§5.4), or undefined while it has none. */
export async function getActiveStore(
  db: pg.Pool,
  accountId: string,
): Promise<ActiveStore | undefined> {
  const { rows } = await db.query<ActiveStore>(
    `SELECT id, namespace, connection, credentials FROM account_stores
      WHERE account_id = $1 AND status = 'active'`,
    [accountId],
  );
  return rows[0];
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaTable {
  name: string;
  /** Every column except the `id` existence marker. */
  columns: SchemaColumn[];
  /** Tables this one has a `<parent>_id` column for (§8). */
  parents: string[];
  children: string[];
}

/** Groups `data_columns` by table and infers parent and child links from the `<parent>_id` convention. */
export async function getSchemaTables(db: pg.Pool, storeId: string): Promise<SchemaTable[]> {
  const { rows } = await db.query<{ table_name: string; column_name: string; logical_type: string }>(
    `SELECT table_name, column_name, logical_type FROM data_columns
      WHERE store_id = $1 ORDER BY table_name, column_name`,
    [storeId],
  );
  return buildSchemaTables(rows.map((r) => [r.table_name, r.column_name, r.logical_type]));
}

export function buildSchemaTables(
  rows: [table: string, column: string, type: string][],
): SchemaTable[] {
  const byTable = new Map<string, SchemaTable>();
  for (const [table, column, type] of rows) {
    let entry = byTable.get(table);
    if (!entry) {
      entry = { name: table, columns: [], parents: [], children: [] };
      byTable.set(table, entry);
    }
    if (column !== 'id') entry.columns.push({ name: column, type });
  }
  for (const table of byTable.values()) {
    for (const { name } of table.columns) {
      if (!name.endsWith('_id')) continue;
      const parent = name.slice(0, -3);
      if (parent === table.name || !byTable.has(parent)) continue;
      table.parents.push(parent);
      byTable.get(parent)!.children.push(table.name);
    }
  }
  return [...byTable.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const COUNT_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 3000;
/** Total time getRowCounts spends starting new counts, connecting included. */
const COUNT_BUDGET_MS = 6000;

/**
 * Exact live row counts (soft-deleted rows excluded), read with the platform credentials from the
 * store's own database over one short-lived connection. A table that times out or fails maps to
 * null, and so does every table when the database can't be reached.
 */
export async function getRowCounts(
  store: ActiveStore,
  key: Buffer,
  tables: string[],
): Promise<Map<string, number | null>> {
  const counts = new Map<string, number | null>(tables.map((t) => [t, null]));
  if (tables.length === 0 || !store.credentials) return counts;

  const deadline = Date.now() + COUNT_BUDGET_MS;
  let client: pg.Client | undefined;
  try {
    const { host, port } = store.connection;
    const { user, password } = decryptJson(key, store.credentials);
    if (typeof host !== 'string' || typeof port !== 'number') return counts;
    client = new pg.Client({
      host,
      port,
      database: store.namespace,
      user: user as string,
      password: password as string,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: COUNT_TIMEOUT_MS,
      query_timeout: COUNT_TIMEOUT_MS + 2000,
    });
    // An error between queries would otherwise crash the process.
    client.on('error', () => undefined);
    await client.connect();
    for (const table of tables) {
      // Out of time: the rest stay unavailable, so a store with many slow tables can't stall the page.
      if (Date.now() > deadline) break;
      try {
        const result = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${pg.escapeIdentifier(table)} WHERE "_deleted_at" IS NULL`,
        );
        counts.set(table, Number(result.rows[0]!.n));
      } catch {
        // Timed out or unreadable: leave this one as null and carry on.
      }
    }
  } catch {
    // Unreachable store database: every count stays unavailable.
  } finally {
    await client?.end().catch(() => undefined);
  }
  return counts;
}

export const TRAFFIC_WINDOW_MINUTES = 60;

export interface TrafficRow {
  /** 0 is the current minute, 59 the oldest. */
  minutesAgo: number;
  source: string;
  op: string;
  count: number;
}

export interface Traffic {
  rows: TrafficRow[];
  bySource: { source: string; count: number }[];
  byOp: { op: string; count: number }[];
  total: number;
}

/** Events received in the last 60 minutes, bucketed by minute and split by (source, op). */
export async function getTraffic(db: pg.Pool, accountId: string): Promise<Traffic> {
  const { rows } = await db.query<{ minutes_ago: number; source: string; op: string; n: string }>(
    `SELECT floor(extract(epoch FROM now() - received_at) / 60)::int AS minutes_ago,
            source, op, count(*) AS n
       FROM events
      WHERE account_id = $1 AND received_at > now() - make_interval(mins => $2)
      GROUP BY 1, source, op
      ORDER BY 1, source, op`,
    [accountId, TRAFFIC_WINDOW_MINUTES],
  );
  const traffic: Traffic = { rows: [], bySource: [], byOp: [], total: 0 };
  const sources = new Map<string, number>();
  const ops = new Map<string, number>();
  for (const r of rows) {
    const count = Number(r.n);
    // An event timestamped slightly in the future counts as the current minute.
    traffic.rows.push({ minutesAgo: Math.max(0, r.minutes_ago), source: r.source, op: r.op, count });
    sources.set(r.source, (sources.get(r.source) ?? 0) + count);
    ops.set(r.op, (ops.get(r.op) ?? 0) + count);
    traffic.total += count;
  }
  traffic.bySource = [...sources]
    .map(([source, count]) => ({ source, count }))
    .sort((x, y) => x.source.localeCompare(y.source));
  traffic.byOp = [...ops].map(([op, count]) => ({ op, count })).sort((x, y) => x.op.localeCompare(y.op));
  return traffic;
}

export interface RetryJob {
  id: string;
  kind: string;
  attempts: number;
  ageSeconds: number;
}

export interface Pipeline {
  depthByKind: { kind: string; count: number }[];
  depth: number;
  /** Age of the oldest queued job in seconds, or null when the queue is empty. */
  oldestAgeSeconds: number | null;
  retries: RetryJob[];
}

const RETRY_LIMIT = 50;

export async function getPipeline(db: pg.Pool, accountId: string): Promise<Pipeline> {
  const [depth, oldest, retries] = await Promise.all([
    db.query<{ kind: string; n: string }>(
      'SELECT kind, count(*) AS n FROM queue WHERE account_id = $1 GROUP BY kind ORDER BY kind',
      [accountId],
    ),
    db.query<{ age: number | null }>(
      'SELECT extract(epoch FROM now() - min(created_at))::float8 AS age FROM queue WHERE account_id = $1',
      [accountId],
    ),
    db.query<{ id: string; kind: string; attempts: number; age: number }>(
      `SELECT id, kind, attempts, extract(epoch FROM now() - created_at)::float8 AS age
         FROM queue WHERE account_id = $1 AND attempts > 1
        ORDER BY attempts DESC, created_at LIMIT ${RETRY_LIMIT}`,
      [accountId],
    ),
  ]);
  const depthByKind = depth.rows.map((r) => ({ kind: r.kind, count: Number(r.n) }));
  return {
    depthByKind,
    depth: depthByKind.reduce((sum, r) => sum + r.count, 0),
    oldestAgeSeconds: oldest.rows[0]?.age ?? null,
    retries: retries.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      attempts: r.attempts,
      ageSeconds: r.age,
    })),
  };
}

import { Hono, type Context } from 'hono';
import {
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
  getReadableStore,
  getTableColumns,
  isFilterable,
  parseFilterValue,
  readRows,
  RESERVED_PARAMS,
  type ReadableStore,
  type RowQuery,
  type TableColumns,
} from '../../tables/rows.js';
import { authenticate } from '../auth.js';
import { HttpError, type AppEnv } from '../deps.js';

/**
 * The public read API. Only `read` keys get in, and never through `?key=`: `ingest` keys are handed
 * to webhook providers, who must not be able to read the account's data.
 */
export const tableRoutes = new Hono<AppEnv>();

interface Target {
  store: ReadableStore;
  table: string;
  columns: TableColumns;
}

async function resolveTable(c: Context<AppEnv>): Promise<Target> {
  const { accountId } = await authenticate(c, { allowQueryKey: false, scope: 'read' });
  const { appDb } = c.get('deps');
  const table = c.req.param('table')!;
  const store = await getReadableStore(appDb, accountId);
  const columns = store && (await getTableColumns(appDb, store.id, table));
  if (!store || !columns) throw new HttpError(404, 'unknown table');
  return { store, table, columns };
}

/** Postgres text can't hold a NUL, so a value with one would fail the query rather than match nothing. */
function textParam(value: string | undefined, name: string): string | undefined {
  if (value?.includes('\0')) throw new HttpError(400, `${name} is not valid`);
  return value;
}

function limitParam(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ROW_LIMIT;
  const limit = /^[1-9]\d{0,3}$/.test(value) ? Number(value) : 0;
  if (limit < 1 || limit > MAX_ROW_LIMIT) {
    throw new HttpError(400, `limit must be a whole number from 1 to ${MAX_ROW_LIMIT}`);
  }
  return limit;
}

/**
 * Every other query parameter must be a filter on a known column. Ignoring an unknown or repeated one
 * would return more rows than the client asked for, as if the filter had matched them.
 */
function filterParams(c: Context<AppEnv>, columns: TableColumns): [string, string][] {
  const filters: [string, string][] = [];
  for (const [name, values] of Object.entries(c.req.queries())) {
    if (RESERVED_PARAMS.has(name)) continue;
    const type = columns.get(name);
    if (type === undefined || !isFilterable(name, type) || values.length !== 1) {
      throw new HttpError(400, 'unknown or repeated query parameter');
    }
    const value = parseFilterValue(type, values[0]!);
    if (value === undefined) throw new HttpError(400, 'a filter value does not fit its column');
    filters.push([name, value]);
  }
  return filters;
}

/** The client gets a plain 503, and only the error code is logged, since messages can quote values. */
async function read(c: Context<AppEnv>, store: ReadableStore, query: RowQuery) {
  try {
    return await readRows(store, c.get('deps').config.encryptionKey, query);
  } catch (error) {
    console.error('table read failed:', (error as { code?: string }).code ?? 'no code');
    throw new HttpError(503, 'table data is unavailable');
  }
}

tableRoutes.get('/:table', async (c) => {
  const { store, table, columns } = await resolveTable(c);
  const limit = limitParam(c.req.query('limit'));
  const after = textParam(c.req.query('after') || undefined, 'after');
  const filters = filterParams(c, columns);
  // One extra row shows whether there is another page.
  const rows = await read(c, store, {
    table,
    columns: [...columns.keys()],
    limit: limit + 1,
    after,
    filters,
  });
  const page = rows.slice(0, limit);
  return c.json({
    rows: page,
    next_after: rows.length > limit ? (page.at(-1)!.id as string) : null,
  });
});

tableRoutes.get('/:table/:id', async (c) => {
  const { store, table, columns } = await resolveTable(c);
  const id = textParam(c.req.param('id'), 'id');
  const [row] = await read(c, store, { table, columns: [...columns.keys()], limit: 1, id });
  if (!row) throw new HttpError(404, 'unknown row');
  return c.json(row);
});

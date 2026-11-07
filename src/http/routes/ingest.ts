import type { Context } from 'hono';
import { Hono } from 'hono';
import type pg from 'pg';
import type { AdapterRequest } from '../../contracts/index.js';
import { fingerprint, FingerprintDepthError } from '../../fingerprint/index.js';
import { authenticate } from '../auth.js';
import { HttpError, type AppEnv } from '../deps.js';

/** Webhook delivery IDs used as the idempotency key when no `Idempotency-Key` is sent, in priority order. */
export const DELIVERY_ID_HEADERS = ['x-github-delivery', 'x-shopify-webhook-id'] as const;

/** Credentials never stored in `events.request`. */
const STRIPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key']);

const MAX_FIELD_BYTES = 255;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const PREFIX = '/ingest';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const ingestRoutes = new Hono<AppEnv>();
ingestRoutes.all('/', handleIngest);
ingestRoutes.all('/*', handleIngest);

async function handleIngest(c: Context<AppEnv>): Promise<Response> {
  const method = c.req.method.toUpperCase();
  if (!WRITE_METHODS.includes(method)) {
    return c.json({ error: 'method not allowed' }, 405, { Allow: WRITE_METHODS.join(', ') });
  }

  // Hono routes on the normalized path, but source comes from the path as received.
  const { path, rawQuery } = rawTarget(c);
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
    return c.json({ error: 'not found' }, 404);
  }

  const { accountId } = await authenticate(c, { allowQueryKey: true });

  const source = sourceOf(path);
  const headers = rawHeaders(c);
  const idempotencyKey = idempotencyKeyOf(headers);
  const request: AdapterRequest = { method, path, query: stripKeyParam(rawQuery), headers: storedHeaders(headers) };

  const body = Buffer.from(await c.req.arrayBuffer());
  const op = method === 'DELETE' ? 'delete' : 'write';
  const parsed = parseBody(body, method);

  let fp: string | null = null;
  let malformed: string | null = null;
  if (parsed.scalar) {
    malformed = 'JSON scalar';
  } else {
    try {
      fp = fingerprint(parsed.data);
    } catch (error) {
      if (!(error instanceof FingerprintDepthError)) throw error;
      malformed = 'nesting too deep';
    }
  }

  const { appDb } = c.get('deps');
  const eventId = await appendEvent(appDb, {
    accountId,
    body,
    source,
    op,
    fingerprint: fp,
    idempotencyKey,
    request,
    malformedDetail: malformed,
  });
  return c.json(
    { status: eventId.malformed ? 'malformed' : 'queued', event_id: eventId.id },
    202,
  );
}

/** The path and raw query as the client sent them. `app.request()` has no Node request, so it falls back to Hono's URL. */
function rawTarget(c: Context<AppEnv>): { path: string; rawQuery: string } {
  let target = c.env?.incoming?.url;
  if (target === undefined) {
    const url = new URL(c.req.url);
    target = url.pathname + url.search;
  }
  const at = target.indexOf('?');
  return at === -1
    ? { path: target, rawQuery: '' }
    : { path: target.slice(0, at), rawQuery: target.slice(at + 1) };
}

/** The first path segment after `/ingest`, percent-decoded. Throws 400 if unusable as a source. */
function sourceOf(path: string): string {
  const segment = path.slice(PREFIX.length + 1).split('/', 1)[0] ?? '';
  let source: string;
  try {
    source = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'path segment is not valid UTF-8');
  }
  if (source.includes('\0')) throw new HttpError(400, 'path segment contains NUL');
  if (Buffer.byteLength(source) > MAX_FIELD_BYTES) {
    throw new HttpError(400, 'path segment is over 255 bytes');
  }
  return source;
}

/** All headers with lowercase names, repeats joined with ", ". */
function rawHeaders(c: Context<AppEnv>): Map<string, string> {
  const headers = new Map<string, string>();
  const add = (name: string, value: string) => {
    const key = name.toLowerCase();
    const previous = headers.get(key);
    headers.set(key, previous === undefined ? value : `${previous}, ${value}`);
  };
  const raw = c.env?.incoming?.rawHeaders;
  if (raw) {
    for (let i = 0; i + 1 < raw.length; i += 2) add(raw[i]!, raw[i + 1]!);
  } else {
    for (const [name, value] of c.req.raw.headers) add(name, value);
  }
  return headers;
}

function storedHeaders(headers: Map<string, string>): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const [name, value] of headers) if (!STRIPPED_HEADERS.has(name)) stored[name] = value;
  return stored;
}

function idempotencyKeyOf(headers: Map<string, string>): string | null {
  for (const name of ['idempotency-key', ...DELIVERY_ID_HEADERS]) {
    const value = headers.get(name);
    if (!value) continue;
    if (Buffer.byteLength(value) > MAX_FIELD_BYTES) {
      throw new HttpError(400, `${name} is over 255 bytes`);
    }
    return value;
  }
  return null;
}

/** Drops every `key` parameter (compared by decoded name) and leaves the rest of the raw query as received. */
export function stripKeyParam(rawQuery: string): string {
  if (rawQuery === '') return '';
  return rawQuery
    .split('&')
    .filter((part) => {
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      try {
        return decodeURIComponent(name) !== 'key';
      } catch {
        return true;
      }
    })
    .join('&');
}

type ParsedBody = { scalar: false; data: unknown } | { scalar: true };

function parseBody(body: Buffer, method: string): ParsedBody {
  if (body.length === 0) {
    if (method === 'DELETE') return { scalar: false, data: null };
    throw new HttpError(400, 'body is not valid JSON');
  }
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new HttpError(400, 'body is not valid UTF-8');
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  return data === null || typeof data !== 'object' ? { scalar: true } : { scalar: false, data };
}

interface NewEvent {
  accountId: string;
  body: Buffer;
  source: string;
  op: 'write' | 'delete';
  fingerprint: string | null;
  idempotencyKey: string | null;
  request: AdapterRequest;
  /** Set when the event is malformed: it is quarantined instead of queued. */
  malformedDetail: string | null;
}

/** Appends the event and its queue or quarantine row in one transaction, or finds the original on a repeat. */
async function appendEvent(
  db: pg.Pool,
  event: NewEvent,
): Promise<{ id: string; malformed: boolean }> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO events (account_id, body, source, op, fingerprint, idempotency_key, request)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (account_id, source, op, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        event.accountId,
        event.body,
        event.source,
        event.op,
        event.fingerprint,
        event.idempotencyKey,
        JSON.stringify(event.request),
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      await client.query('COMMIT');
      // On this client: asking the pool for a second connection while holding this one can deadlock it.
      const original = await client.query<{ id: string; fingerprint: string | null }>(
        `SELECT id, fingerprint FROM events
         WHERE account_id = $1 AND source = $2 AND op = $3 AND idempotency_key = $4`,
        [event.accountId, event.source, event.op, event.idempotencyKey],
      );
      const found = original.rows[0];
      if (!found) throw new Error('idempotent event vanished');
      return { id: found.id, malformed: found.fingerprint === null };
    }
    if (event.malformedDetail !== null) {
      await client.query(
        `INSERT INTO quarantine (event_id, account_id, store_id, reason, detail)
         VALUES ($1, $2, NULL, 'malformed', $3)`,
        [row.id, event.accountId, event.malformedDetail],
      );
    } else {
      await client.query(`INSERT INTO queue (account_id, kind, event_id) VALUES ($1, 'ingest', $2)`, [
        event.accountId,
        row.id,
      ]);
    }
    await client.query('COMMIT');
    return { id: row.id, malformed: event.malformedDetail !== null };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // Don't return a connection that may still be inside a transaction to the pool.
    }
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
}

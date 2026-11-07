// The internal adapter and quarantine routes (PRD §13.1), as a Hono app that a service mounts with
// `app.route('/', createInternalRoutes({ pool }))`. Handlers only translate HTTP; the logic is in
// store.ts, so the generator can call it directly.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type pg from 'pg';
import { SandboxUnavailableError } from '../sandbox/index.js';
import { checkOpaquePaths, type GateResult } from './gate.js';
import {
  QUARANTINE_REASONS,
  createAdapter,
  listQuarantine,
  requestReplay,
  validateAdapter,
  validateAndActivate,
  type AdapterOp,
  type NewAdapter,
  type QuarantineFilter,
  type QuarantineReason,
  type SampleOptions,
} from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const MAX_SOURCE_BYTES = 255;
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

/** Caddy adds X-Forwarded-For and X-Account-Slug to everything it proxies (§14.2). */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'via', 'x-account-slug'];

/**
 * These routes are internal because Caddy forwards only `/ingest` to this service (§14.2). This guard
 * is the backstop if that routing is ever wrong: a request that came through a proxy gets a 404.
 */
const internalOnly: MiddlewareHandler = async (c, next) => {
  if (PROXY_HEADERS.some((header) => c.req.header(header) !== undefined)) {
    return c.json({ error: 'not found' }, 404);
  }
  return next();
};

export interface InternalRoutesOptions {
  pool: pg.Pool;
  gate?: SampleOptions;
}

function isPlainText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0');
}

function parseOp(value: unknown): AdapterOp | undefined {
  return value === 'write' || value === 'delete' ? value : undefined;
}

/** Checks a `POST /adapters` body, which is untrusted, and returns the problem as text. */
function parseNewAdapter(body: unknown): NewAdapter | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'The body must be a JSON object.';
  const { account_id: accountId, op, fingerprint, code, source = '', opaque_paths: opaquePaths = [] } = body as Record<string, unknown>;

  if (typeof accountId !== 'string' || !UUID.test(accountId)) return 'account_id must be a UUID.';
  const parsedOp = parseOp(op);
  if (!parsedOp) return 'op must be write or delete.';
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return 'fingerprint must be 16 lowercase hex characters.';
  if (!isPlainText(code) || code.trim() === '') return 'code must be a non-empty string.';
  if (!isPlainText(source) || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    return `source must be a string of at most ${MAX_SOURCE_BYTES} bytes.`;
  }
  if (!Array.isArray(opaquePaths) || !opaquePaths.every(isPlainText)) return 'opaque_paths must be an array of strings.';
  const [badPath] = checkOpaquePaths(opaquePaths);
  if (badPath) return badPath.detail;

  return { account_id: accountId, op: parsedOp, fingerprint, code, source, opaque_paths: opaquePaths };
}

/** Checks `GET /quarantine` query parameters, and returns the problem as text. */
function parseQuarantineFilter(c: Context): QuarantineFilter | string {
  const { account_id: accountId, source, op, fingerprint, reason, limit = String(DEFAULT_PAGE_SIZE), offset = '0' } = c.req.query();

  if (accountId === undefined || !UUID.test(accountId)) return 'account_id must be a UUID.';
  if (op !== undefined && !parseOp(op)) return 'op must be write or delete.';
  if (reason !== undefined && !QUARANTINE_REASONS.includes(reason as QuarantineReason)) {
    return `reason must be one of ${QUARANTINE_REASONS.join(', ')}.`;
  }
  if ((source !== undefined && !isPlainText(source)) || (fingerprint !== undefined && !isPlainText(fingerprint))) {
    return 'source and fingerprint must not contain a NUL byte.';
  }
  if (!/^\d{1,7}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE_SIZE) {
    return `limit must be between 1 and ${MAX_PAGE_SIZE}.`;
  }
  if (!/^\d{1,9}$/.test(offset)) return 'offset must be a non-negative integer.';

  return {
    accountId,
    limit: Number(limit),
    offset: Number(offset),
    ...(source !== undefined ? { source } : {}),
    ...(op !== undefined ? { op: op as AdapterOp } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
    ...(reason !== undefined ? { reason: reason as QuarantineReason } : {}),
  };
}

/** The gate's result in the API's snake_case. */
function presentGate(gate: GateResult) {
  return {
    ok: gate.ok,
    failures: gate.failures.map(({ code, detail, eventId }) => ({ code, detail, event_id: eventId ?? null })),
    samples: gate.samples.map(({ eventId, output, schemaChanges }) => ({
      event_id: eventId,
      output,
      schema_changes: schemaChanges ?? [],
    })),
    replacing: gate.replacing,
  };
}

export function createInternalRoutes({ pool, gate }: InternalRoutesOptions): Hono {
  const app = new Hono();

  // Paths are named, not `*`. A mounted app's `*` middleware would also cover the parent's `/ingest`,
  // where every request comes through Caddy.
  app.use('/adapters/*', internalOnly);
  app.use('/quarantine', internalOnly);

  app.onError((error, c) => {
    if (error instanceof SandboxUnavailableError) {
      return c.json({ error: 'The adapter sandbox is unavailable. Try again.' }, 503);
    }
    console.error('Internal route failed:', error);
    return c.json({ error: 'internal error' }, 500);
  });

  app.post(
    '/adapters',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'The body is too large.' }, 413) }),
    async (c) => {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'The body must be valid JSON.' }, 400);
      }
      const input = parseNewAdapter(body);
      if (typeof input === 'string') return c.json({ error: input }, 400);
      const adapter = await createAdapter(pool, input);
      return adapter ? c.json(adapter, 201) : c.json({ error: 'account not found' }, 404);
    },
  );

  app.post('/adapters/:id/test', async (c) => {
    const id = c.req.param('id');
    const result = UUID.test(id) ? await validateAdapter(pool, id, gate) : null;
    return result ? c.json(presentGate(result.gate)) : c.json({ error: 'adapter not found' }, 404);
  });

  app.post('/adapters/:id/activate', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'adapter not found' }, 404);
    const result = await validateAndActivate(pool, id, gate);
    switch (result.status) {
      case 'activated':
        return c.json(result.adapter);
      case 'failed':
        return c.json({ error: 'The adapter failed validation.', ...presentGate(result.gate) }, 422);
      case 'not_found':
        return c.json({ error: 'adapter not found' }, 404);
      case 'not_validated':
      case 'stale':
        return c.json({ error: 'Another version changed while this one was validating. Try again.' }, 409);
    }
  });

  app.post('/adapters/:id/replay', async (c) => {
    const id = c.req.param('id');
    const result = UUID.test(id) ? await requestReplay(pool, id) : 'not_found';
    if (result === 'not_found') return c.json({ error: 'adapter not found' }, 404);
    if (result === 'not_active') return c.json({ error: 'Only an active adapter can be replayed.' }, 409);
    return c.json({ status: 'enqueued' }, 202);
  });

  app.get('/quarantine', async (c) => {
    const filter = parseQuarantineFilter(c);
    if (typeof filter === 'string') return c.json({ error: filter }, 400);
    return c.json({ rows: await listQuarantine(pool, filter) });
  });

  return app;
}

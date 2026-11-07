// The internal adapter and quarantine routes (PRD §13.1). Handlers only translate HTTP. The logic is in
// src/adapters, so the generator can call it directly.
import { Hono, type Context } from 'hono';
import {
  QUARANTINE_REASONS,
  checkOpaquePaths,
  createAdapter,
  listQuarantine,
  requestReplay,
  validateAdapter,
  validateAndActivate,
  type AdapterOp,
  type GateResult,
  type NewAdapter,
  type QuarantineFilter,
  type QuarantineReason,
} from '../../adapters/index.js';
import { internalOnly } from '../auth.js';
import { HttpError, type AppEnv } from '../deps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const MAX_SOURCE_BYTES = 255;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

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
function parseQuarantineFilter(c: Context<AppEnv>): QuarantineFilter | string {
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

export const adapterRoutes = new Hono<AppEnv>();
export const quarantineRoutes = new Hono<AppEnv>();

// A mounted app's `*` stops at its prefix, so this can't reach /ingest, where every request comes through Caddy.
adapterRoutes.use('*', internalOnly);
quarantineRoutes.use('*', internalOnly);

adapterRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    throw new HttpError(400, 'The body must be valid JSON.');
  }
  const input = parseNewAdapter(body);
  if (typeof input === 'string') throw new HttpError(400, input);
  const adapter = await createAdapter(c.get('deps').appDb, input);
  if (!adapter) throw new HttpError(404, 'account not found');
  return c.json(adapter, 201);
});

adapterRoutes.post('/:id/test', async (c) => {
  const { appDb, gate } = c.get('deps');
  const id = c.req.param('id');
  const result = UUID.test(id) ? await validateAdapter(appDb, id, gate) : null;
  if (!result) throw new HttpError(404, 'adapter not found');
  return c.json(presentGate(result.gate));
});

adapterRoutes.post('/:id/activate', async (c) => {
  const { appDb, gate } = c.get('deps');
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new HttpError(404, 'adapter not found');
  const result = await validateAndActivate(appDb, id, gate);
  switch (result.status) {
    case 'activated':
      return c.json(result.adapter);
    case 'failed':
      return c.json({ error: 'The adapter failed validation.', ...presentGate(result.gate) }, 422);
    case 'not_found':
      throw new HttpError(404, 'adapter not found');
    case 'not_validated':
    case 'stale':
      throw new HttpError(409, 'Another version changed while this one was validating. Try again.');
  }
});

adapterRoutes.post('/:id/replay', async (c) => {
  const id = c.req.param('id');
  const result = UUID.test(id) ? await requestReplay(c.get('deps').appDb, id) : 'not_found';
  if (result === 'not_found') throw new HttpError(404, 'adapter not found');
  if (result === 'not_active') throw new HttpError(409, 'Only an active adapter can be replayed.');
  return c.json({ status: 'enqueued' }, 202);
});

quarantineRoutes.get('/', async (c) => {
  const filter = parseQuarantineFilter(c);
  if (typeof filter === 'string') throw new HttpError(400, filter);
  return c.json({ rows: await listQuarantine(c.get('deps').appDb, filter) });
});

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpError, readBody } from './http.js';

export interface StubEvent {
  event_id: string;
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** The first response to each repeatable delivery, by source, op, and key. */
type Accepted = Map<string, { status: string; event_id: string }>;

export interface Stub {
  /** The stub's ingest route, such as http://127.0.0.1:43127/ingest. */
  url: string;
  close(): Promise<void>;
}

/**
 * A stand-in for /ingest that follows the responses in PRD §13.1, on a real port so the site
 * sends the same HTTP requests it would send to the real service. It stores nothing except what
 * it needs to answer a repeated delivery. It accepts any API key, as a bearer token or ?key=.
 */
export async function startStub(onEvent: (event: StubEvent) => void = () => {}): Promise<Stub> {
  const accepted: Accepted = new Map();
  const server = createServer((req, res) => {
    handle(req, res, onEvent, accepted).catch((error: unknown) => {
      if (error instanceof HttpError) {
        respond(res, error.status, { error: error.message });
      } else {
        console.error('stub failed', error);
        respond(res, 500, { error: 'stub failed' });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/ingest`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  onEvent: (event: StubEvent) => void,
  accepted: Accepted,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/ingest' && !path.startsWith('/ingest/')) {
    respond(res, 404, { error: 'not found' });
    return;
  }
  const method = req.method ?? '';
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    respond(res, 405, { error: 'method not allowed' });
    return;
  }
  const keyInUrl = new URL(req.url ?? '/', 'http://stub').searchParams.get('key');
  if (!keyInUrl && !/^Bearer \S/.test(req.headers.authorization ?? '')) {
    respond(res, 401, { error: 'missing API key' });
    return;
  }
  const firstSegment = path.split('/')[2] ?? '';
  if (!isValidSegment(firstSegment)) {
    respond(res, 400, { error: 'invalid path segment' });
    return;
  }
  const idempotencyKey = deliveryKey(req);
  if (idempotencyKey !== undefined && Buffer.byteLength(idempotencyKey) > 255) {
    respond(res, 400, { error: 'Idempotency-Key is too long' });
    return;
  }

  const text = await readBody(req);
  let body: unknown = null;
  if (text !== '' || method !== 'DELETE') {
    try {
      body = JSON.parse(text);
    } catch {
      respond(res, 400, { error: 'body is not valid JSON' });
      return;
    }
  }

  const source = decodeURIComponent(firstSegment); // Valid, as isValidSegment checked.
  const scope = `${source} ${method === 'DELETE' ? 'delete' : 'write'} ${idempotencyKey}`;
  const original = idempotencyKey === undefined ? undefined : accepted.get(scope);
  if (original) {
    respond(res, 202, original);
    return;
  }

  const event_id = randomUUID();
  onEvent({ event_id, method, path, headers: req.headers, body });
  // Only a DELETE gets here with no body. A scalar, null included, is valid JSON but malformed (PRD §5.3).
  const wellFormed = text === '' || (typeof body === 'object' && body !== null);
  const result = { status: wellFormed ? 'queued' : 'malformed', event_id };
  if (idempotencyKey !== undefined) accepted.set(scope, result);
  respond(res, 202, result);
}

/** PRD §6.2: a provider's delivery header counts as the key when none is sent. */
function deliveryKey(req: IncomingMessage): string | undefined {
  for (const name of ['idempotency-key', 'x-github-delivery', 'x-shopify-webhook-id']) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** PRD §6: at most 255 bytes, and it must percent-decode to valid UTF-8 with no NUL. */
function isValidSegment(segment: string): boolean {
  try {
    const source = decodeURIComponent(segment);
    return Buffer.byteLength(source) <= 255 && !source.includes('\0');
  } catch {
    return false;
  }
}

function respond(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

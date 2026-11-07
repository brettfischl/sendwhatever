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

export interface Stub {
  /** The stub's ingest route, such as http://127.0.0.1:43127/ingest. */
  url: string;
  close(): Promise<void>;
}

/**
 * A stand-in for /ingest that follows the responses in PRD §13.1, on a real port so the site
 * sends the same HTTP requests it would send to the real service. It stores nothing. It accepts
 * any bearer token, and doesn't implement Idempotency-Key because the site doesn't send one.
 */
export async function startStub(onEvent: (event: StubEvent) => void = () => {}): Promise<Stub> {
  const server = createServer((req, res) => {
    handle(req, res, onEvent).catch((error: unknown) => {
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
  if (!/^Bearer \S/.test(req.headers.authorization ?? '')) {
    respond(res, 401, { error: 'missing API key' });
    return;
  }
  const firstSegment = path.split('/')[2] ?? '';
  if (!isValidSegment(firstSegment)) {
    respond(res, 400, { error: 'invalid path segment' });
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

  const event_id = randomUUID();
  onEvent({ event_id, method, path, headers: req.headers, body });
  // Only a DELETE may have no body. A scalar is valid JSON, but malformed (PRD §5.3).
  const wellFormed = typeof body === 'object' && (body !== null || method === 'DELETE');
  respond(res, 202, { status: wellFormed ? 'queued' : 'malformed', event_id });
}

/** PRD §6: at most 255 bytes, and it must percent-decode to valid UTF-8 with no NUL. */
function isValidSegment(segment: string): boolean {
  if (Buffer.byteLength(segment) > 255) return false;
  try {
    return !decodeURIComponent(segment).includes('\0');
  } catch {
    return false;
  }
}

function respond(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

import { HttpError } from './http.js';
import {
  describeError,
  parseResponse,
  type IngestClientOptions,
  type LogEntry,
} from './ingest-client.js';
import { freshFlow, shopifyFlows } from './shopify/index.js';

/** Served at these names by the demo server. The console's views add theirs here. */
export const CONSOLE_ASSETS: Record<string, string> = {
  '/assets/console.css': 'text/css',
  '/assets/console.js': 'text/javascript',
  '/assets/console-arbitrary.js': 'text/javascript',
  '/assets/console-flows.js': 'text/javascript',
  '/assets/console-format.js': 'text/javascript',
  '/assets/console-tables.js': 'text/javascript',
  '/assets/console-webhooks.js': 'text/javascript',
};

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_LABEL = 'Console';
const MAX_LABEL_LENGTH = 200;
const MASK = '••••••••';

/**
 * The server sets auth and the account, and the HTTP client owns framing. Letting a browser set
 * these could override the configured key or make the request differ from what the panel shows.
 */
const RESERVED_HEADERS = new Set([
  'authorization',
  'x-account-slug',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
]);

/**
 * The guided flows for the browser. Each call is a new set of deliveries, so a page that asks again
 * starts a run that ingest treats as new. Sending a copy it already has is what looks like a retry.
 */
export function consoleFlows() {
  return shopifyFlows.map((flow) => freshFlow(flow));
}

export interface RawIngestRequest {
  label: string;
  method: string;
  /** Anything after /ingest, and optionally a query. */
  path: string;
  headers: Record<string, string>;
  /** The exact text to send, which may not be valid JSON. Null sends no body. */
  body: string | null;
  /** Webhook sources can't set headers, so they carry the key in the URL (PRD §13.4). */
  auth: 'bearer' | 'key';
}

export type SendRaw = (request: RawIngestRequest) => Promise<LogEntry>;

/** Checks a browser's request. A problem here means nothing is sent. */
export function parseConsoleRequest(input: Record<string, unknown>): RawIngestRequest {
  const { method, path = '', headers = {}, body = null, auth = 'bearer', label = DEFAULT_LABEL } = input;
  if (typeof method !== 'string' || !METHODS.includes(method)) {
    throw new HttpError(400, `method must be one of ${METHODS.join(', ')}`);
  }
  if (typeof path !== 'string') throw new HttpError(400, 'path must be a string');
  if (body !== null && typeof body !== 'string') {
    throw new HttpError(400, 'body must be the text to send, or null for no body');
  }
  if (auth !== 'bearer' && auth !== 'key') throw new HttpError(400, 'auth must be bearer or key');
  if (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH) {
    throw new HttpError(400, `label must be a string of up to ${MAX_LABEL_LENGTH} characters`);
  }
  return { label, method, path, headers: parseHeaders(headers), body, auth };
}

function parseHeaders(headers: unknown): Record<string, string> {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new HttpError(400, 'headers must be an object of names and values');
  }
  const seen = new Set<string>();
  const checked = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw new HttpError(400, `header ${name} must be a string`);
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      throw new HttpError(400, `${name} can't be set here: the demo server and its HTTP client set it`);
    }
    if (seen.has(lower)) throw new HttpError(400, `header ${name} appears more than once`);
    seen.add(lower);
    try {
      checked.set(name, value);
    } catch {
      throw new HttpError(400, `header ${name} has an invalid name or value`);
    }
  }
  return headers as Record<string, string>;
}

/**
 * Like the ingest client, but sends exactly what it's given: any text, any headers, and optionally
 * the key in the URL. It adds only the configured auth and slug. Failing to reach ingest comes back
 * as a log entry, and a request that was refused before sending throws an HttpError.
 */
export function createRawIngestClient(options: IngestClientOptions): SendRaw {
  const { apiKey, accountSlug, log, timeoutMs = 10_000 } = options;
  const baseUrl = options.url.replace(/\/+$/, '');
  // Nothing from ingest is trusted not to echo the key, and this all goes to the browser.
  const scrub = (text: string) =>
    text.replaceAll(apiKey, MASK).replaceAll(encodeURIComponent(apiKey), MASK);

  return async function sendRaw(request) {
    const url = buildUrl(baseUrl, request.path);
    const inUrl = request.auth === 'key';
    // url.search is empty for a bare trailing ?, which url.href keeps.
    const separator = url.search ? '&' : url.href.endsWith('?') ? '' : '?';
    const urlWith = (key: string) => (inUrl ? `${url.href}${separator}key=${key}` : url.href);
    const visibleHeaders: Record<string, string> = {
      ...request.headers,
      ...(accountSlug ? { 'X-Account-Slug': accountSlug } : {}),
    };
    const startedAt = Date.now();
    const finish = (outcome: Pick<LogEntry, 'response' | 'error'>) =>
      log.add({
        at: new Date(startedAt).toISOString(),
        label: request.label,
        method: request.method,
        url: urlWith(MASK),
        headers: {
          ...(inUrl ? {} : { Authorization: `Bearer ${MASK}` }),
          ...visibleHeaders,
        },
        body: parseIfJson(request.body),
        ...(request.body === null ? {} : { rawBody: request.body }),
        duration_ms: Date.now() - startedAt,
        ...outcome,
      });

    try {
      const response = await fetch(urlWith(encodeURIComponent(apiKey)), {
        method: request.method,
        headers: {
          ...(inUrl ? {} : { Authorization: `Bearer ${apiKey}` }),
          ...visibleHeaders,
        },
        // Bytes, because fetch would add a Content-Type of its own to a string.
        ...(request.body === null ? {} : { body: Buffer.from(request.body) }),
        // Show a redirect rather than follow it, which could carry a key in the URL to a new host.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      return finish({
        response: {
          status: response.status,
          statusText: scrub(response.statusText),
          headers: Object.fromEntries(
            [...response.headers].map(([name, value]) => [scrub(name), scrub(value)]),
          ),
          body: parseResponse(scrub(text)),
        },
      });
    } catch (error) {
      return finish({ error: scrub(describeError(error)) });
    }
  };
}

function buildUrl(baseUrl: string, rawPath: string): URL {
  const path = rawPath.replace(/^\/+/, '');
  const url = new URL(!path || path.startsWith('?') ? `${baseUrl}${path}` : `${baseUrl}/${path}`);
  url.hash = '';

  // Parsing resolves dot segments, including encoded ones, so this catches anything that climbs out.
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    throw new HttpError(400, `path must stay under ${basePath || '/'}`);
  }
  if (url.searchParams.has('key')) {
    throw new HttpError(400, "key can't be set in the path: the demo server adds the configured key");
  }
  return url;
}

function parseIfJson(body: string | null): unknown {
  if (body === null) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

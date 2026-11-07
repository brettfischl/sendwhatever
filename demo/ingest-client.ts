import type { IngestRequest } from './payloads.js';

export interface LogEntry {
  id: number;
  at: string;
  label: string;
  method: string;
  url: string;
  /** As sent, except that the API key is masked. This goes to the browser. */
  headers: Record<string, string>;
  /** The parsed body. Undefined when there was none, or it wasn't valid JSON. */
  body: unknown;
  /** The exact text sent, for the console, which can send anything. */
  rawBody?: string;
  response?: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body: unknown;
  };
  /** Set when no response came back, such as connection refused or a timeout. */
  error?: string;
  duration_ms: number;
}

const MAX_LOG_ENTRIES = 500;
const MAX_LOGGED_RESPONSE_CHARS = 10_000;

/** The most recent requests, for the panel on every page. */
export class RequestLog {
  readonly entries: LogEntry[] = [];
  private nextId = 1;

  constructor(private readonly onChange: (event: LogChange) => void = () => {}) {}

  add(entry: Omit<LogEntry, 'id'>): LogEntry {
    const added = { id: this.nextId++, ...entry };
    this.entries.push(added);
    if (this.entries.length > MAX_LOG_ENTRIES) this.entries.shift();
    this.onChange({ kind: 'added', entry: added });
    return added;
  }

  clear(): void {
    this.entries.length = 0;
    this.onChange({ kind: 'cleared' });
  }
}

export type LogChange = { kind: 'added'; entry: LogEntry } | { kind: 'cleared' };

export interface IngestClientOptions {
  /** The ingest route, such as http://localhost:3000/ingest. */
  url: string;
  apiKey: string;
  /** Sent as X-Account-Slug, which stands in for the subdomain in development (PRD §14.2). */
  accountSlug?: string;
  log: RequestLog;
  timeoutMs?: number;
}

export type Send = (request: IngestRequest) => Promise<LogEntry>;

/**
 * Sends a request and logs what happened. A failure comes back as a log entry instead of an
 * exception: the demo should show a 503 or a refused connection, not stop on it.
 */
export function createIngestClient(options: IngestClientOptions): Send {
  const { apiKey, accountSlug, log, timeoutMs = 10_000 } = options;
  const baseUrl = options.url.replace(/\/+$/, '');

  return async function send(request) {
    const url = request.path ? `${baseUrl}/${request.path}` : baseUrl;
    const visibleHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(accountSlug ? { 'X-Account-Slug': accountSlug } : {}),
    };
    const bodyText = JSON.stringify(request.body);
    const startedAt = Date.now();
    const finish = (outcome: Pick<LogEntry, 'response' | 'error'>) =>
      log.add({
        at: new Date(startedAt).toISOString(),
        label: request.label,
        method: request.method,
        url,
        headers: { Authorization: 'Bearer ••••••••', ...visibleHeaders },
        // Parsed from what was sent, because the site keeps changing the objects it built this from.
        body: JSON.parse(bodyText) as object,
        duration_ms: Date.now() - startedAt,
        ...outcome,
      });

    try {
      const response = await fetch(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${apiKey}`, ...visibleHeaders },
        body: bodyText,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return finish({
        response: { status: response.status, body: parseResponse(await response.text()) },
      });
    } catch (error) {
      return finish({ error: describeError(error) });
    }
  };
}

export function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, MAX_LOGGED_RESPONSE_CHARS);
  }
}

/** fetch reports most failures as "fetch failed", with the useful part in `cause`. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

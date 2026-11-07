import { readFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import { CONSOLE_ASSETS, consoleFlows, parseConsoleRequest, type SendRaw } from './console.js';
import { HttpError, readBody } from './http.js';
import type { RequestLog, LogChange } from './ingest-client.js';
import type { LookalikeKind, SessionTransition } from './payloads.js';
import { simulateViewers } from './simulate.js';
import { serveTablesPanel } from './tables-routes.js';
import type { TablesSource } from './tables.js';
import type { NewSession, Webinar } from './webinar.js';

export interface ServerDeps {
  webinar: Webinar;
  log: RequestLog;
  /** Shown in the page header. Must not contain the API key. */
  target: { mode: 'stub' | 'real'; url: string; accountSlug: string | undefined };
  /** Passed to the simulator, so tests don't wait out its pauses. */
  simulatePauseMs?: number;
  /** Feeds the live tables panel. Without one, the panel shows the stub notice. */
  tables?: TablesSource;
  /** Sends from the console. Without it, the console can't send. */
  consoleSend?: SendRaw;
}

/** Asset names are fixed, so a request path never reaches the filesystem. */
const ASSETS: Record<string, string> = {
  '/assets/app.css': 'text/css',
  '/assets/common.js': 'text/javascript',
  '/assets/index.js': 'text/javascript',
  '/assets/session.js': 'text/javascript',
  '/assets/watch.js': 'text/javascript',
  ...CONSOLE_ASSETS,
};
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));

const MAX_SIMULATED_VIEWERS = 200;

type Json = Record<string, unknown>;
type Handler = (params: string[], body: Json) => Promise<unknown>;

/** Pushes changes to open pages over server-sent events. */
export class SiteEvents {
  private readonly clients = new Set<ServerResponse>();

  add(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  sessionChanged(sessionId: string): void {
    this.broadcast('session', { id: sessionId });
  }

  logChanged(change: LogChange): void {
    if (change.kind === 'added') this.broadcast('log', change.entry);
    else this.broadcast('log-cleared', {});
  }

  private broadcast(event: string, data: object): void {
    for (const client of this.clients) {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}

export function createDemoServer(deps: ServerDeps, events: SiteEvents): Server {
  const routes = buildRoutes(deps);

  return createServer((req, res) => {
    (serveTablesPanel(req, res, deps.tables) ?? handle(req, res, routes, events)).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? 'internal error' : (error as Error).message;
      if (res.headersSent) res.end();
      else sendJson(res, status, { error: message });
    });
  });
}

function buildRoutes({ webinar, log, target, simulatePauseMs, consoleSend }: ServerDeps) {
  const route = (method: string, pattern: string, handler: Handler) => ({
    method,
    pattern: new RegExp(`^${pattern.replaceAll(':id', '([^/]+)')}$`),
    handler,
  });

  return [
    route('GET', '/api/meta', async () => target),
    route('GET', '/api/log', async () => log.entries),
    route('DELETE', '/api/log', async () => {
      log.clear();
      return {};
    }),
    route('GET', '/api/sessions', async () => webinar.listSessions()),
    route('POST', '/api/sessions', async (_, body) => webinar.createSession(parseNewSession(body))),
    route('GET', '/api/sessions/:id', async ([id]) => webinar.getSession(id!)),
    route('POST', '/api/sessions/:id/status', async ([id], body) => {
      await webinar.setStatus(id!, oneOf<SessionTransition>(body.status, ['live', 'ended', 'cancelled'], 'status'));
      return {};
    }),
    route('POST', '/api/sessions/:id/lookalikes', async ([id], body) => {
      const kind = oneOf<LookalikeKind>(body.kind, ['speaker', 'sponsor'], 'kind');
      await webinar.addLookalike(id!, kind, text(body, 'name'), body.use_path === true);
      return {};
    }),
    route('POST', '/api/sessions/:id/registrations', async ([id], body) =>
      webinar.register(id!, {
        email: email(body),
        first_name: text(body, 'first_name'),
        last_name: text(body, 'last_name'),
        ...optionalText(body, 'company'),
        ...optionalText(body, 'job_title'),
        marketing_consent: body.marketing_consent === true,
      }),
    ),
    route('POST', '/api/sessions/:id/comments', async ([id], body) => {
      const [comment] = await webinar.postComments(id!, [
        { registrationId: text(body, 'registration_id'), body: text(body, 'body', 2000) },
      ]);
      return comment;
    }),
    route('POST', '/api/sessions/:id/simulate', async ([id], body) => {
      const viewers = integer(body.viewers, 'viewers', 2, MAX_SIMULATED_VIEWERS);
      // Fail now if the session can't take activity. The run itself continues after the response.
      const { session } = webinar.getSession(id!);
      if (session.status === 'ended' || session.status === 'cancelled') {
        throw new HttpError(409, `this session is ${session.status}`);
      }
      simulateViewers(webinar, id!, {
        viewers,
        ...(simulatePauseMs === undefined ? {} : { pauseMs: simulatePauseMs }),
      }).catch((error: unknown) => console.error('simulation failed', error));
      return { started: true, viewers };
    }),
    route('POST', '/api/registrations/:id/join', async ([id]) => {
      await webinar.join(id!);
      return {};
    }),
    route('POST', '/api/registrations/:id/leave', async ([id]) => {
      await webinar.leave(id!);
      return {};
    }),
    route('POST', '/api/registrations/:id/cancel', async ([id], body) => {
      await webinar.cancelRegistration(id!, optionalText(body, 'reason').reason ?? 'cancelled_by_viewer');
      return {};
    }),
    route('POST', '/api/comments/:id/remove', async ([id]) => {
      await webinar.removeComment(id!);
      return {};
    }),
    route('GET', '/api/console/flows', async () => consoleFlows()),
    ...(consoleSend
      ? [route('POST', '/api/console/send', async (_, body) => consoleSend(parseConsoleRequest(body)))]
      : []),
  ];
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  routes: ReturnType<typeof buildRoutes>,
  events: SiteEvents,
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    if (pathname === '/api/stream') return events.add(res);
    if (pathname === '/') return sendFile(res, 'index.html', 'text/html');
    if (pathname === '/console') return sendFile(res, 'console.html', 'text/html');
    if (/^\/sessions\/[^/]+$/.test(pathname)) return sendFile(res, 'session.html', 'text/html');
    if (/^\/sessions\/[^/]+\/watch$/.test(pathname)) return sendFile(res, 'watch.html', 'text/html');
    const assetType = ASSETS[pathname];
    if (assetType) return sendFile(res, pathname.slice('/assets/'.length), assetType);
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const body = method === 'POST' ? await readJson(req) : {};
    const result = await route.handler(match.slice(1), body);
    return sendJson(res, method === 'POST' ? 201 : 200, result);
  }
  throw new HttpError(404, 'not found');
}

/** Requiring JSON means another site's plain form post can't drive this server. */
async function readJson(req: IncomingMessage): Promise<Json> {
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'send application/json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed as Json;
}

function parseNewSession(body: Json): NewSession {
  const startsAt = new Date(text(body, 'starts_at'));
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'starts_at is not a valid time');
  const timezone = text(body, 'timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new HttpError(400, 'timezone is not a valid IANA time zone');
  }

  return {
    title: text(body, 'title'),
    description: optionalText(body, 'description', 2000).description ?? '',
    starts_at: startsAt,
    timezone,
    capacity: integer(body.capacity, 'capacity', 1, 1_000_000),
    tags: list(body.tags, 'tags').map((tag) => {
      if (typeof tag !== 'string' || !tag) throw new HttpError(400, 'tags must be strings');
      return tag;
    }),
    speakers: list(body.speakers, 'speakers').map((speaker) => ({
      name: text(speaker as Json, 'name'),
      ...optionalText(speaker as Json, 'title'),
      ...optionalText(speaker as Json, 'company'),
    })),
    agenda: list(body.agenda, 'agenda').map((item) => ({
      title: text(item as Json, 'title'),
      duration_minutes: integer((item as Json).duration_minutes, 'duration_minutes', 1, 1440),
      ...optionalText(item as Json, 'speaker'),
    })),
  };
}

function text(body: Json, key: string, maxLength = 500): string {
  const value = typeof body?.[key] === 'string' ? (body[key] as string).trim() : '';
  if (!value) throw new HttpError(400, `${key} is required`);
  if (value.length > maxLength) throw new HttpError(400, `${key} is too long`);
  return value;
}

function optionalText(body: Json, key: string, maxLength = 500): Record<string, string> {
  return typeof body?.[key] === 'string' && body[key].trim() ? { [key]: text(body, key, maxLength) } : {};
}

function email(body: Json): string {
  const value = text(body, 'email');
  if (!/^[^\s@]+@[^\s@]+$/.test(value)) throw new HttpError(400, 'email is not valid');
  return value;
}

function integer(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${key} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function list(value: unknown, key: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${key} must be a list`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: T[], key: string): T {
  if (!allowed.includes(value as T)) throw new HttpError(400, `${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}

async function sendFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const content = await readFile(`${PUBLIC_DIR}${file}`);
  res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
  res.end(content);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

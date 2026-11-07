import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createIngestClient, RequestLog, type LogChange } from './ingest-client.js';
import { lookalike, type IngestRequest } from './payloads.js';
import { startStub, type Stub, type StubEvent } from './stub.js';

const API_KEY = 'sw_live_supersecret';
const request: IngestRequest = { label: 'Test', method: 'POST', path: '', body: { id: 'a', name: 'b' } };

let stub: Stub;
let received: StubEvent[] = [];

beforeAll(async () => {
  stub = await startStub((event) => received.push(event));
});
afterAll(() => stub.close());
beforeEach(() => {
  received = [];
});

function client(overrides: Partial<Parameters<typeof createIngestClient>[0]> = {}) {
  const log = new RequestLog();
  return { log, send: createIngestClient({ url: stub.url, apiKey: API_KEY, accountSlug: 'acme', log, ...overrides }) };
}

describe('sending to the stub', () => {
  it('sends the body, key, and slug, and gets a 202 with an event_id', async () => {
    const { send } = client();
    const entry = await send(request);

    expect(received).toHaveLength(1);
    const [event] = received;
    expect(event).toMatchObject({ method: 'POST', path: '/ingest', body: { id: 'a', name: 'b' } });
    expect(event?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(event?.headers['x-account-slug']).toBe('acme');
    expect(event?.headers['content-type']).toBe('application/json');

    expect(entry.response?.status).toBe(202);
    expect(entry.response?.body).toEqual({ status: 'queued', event_id: event?.event_id });
  });

  it('leaves out the slug header when no slug is set', async () => {
    const { send } = client({ accountSlug: undefined });
    await send(request);
    expect(received[0]?.headers).not.toHaveProperty('x-account-slug');
  });

  it('appends the path, tolerating a trailing slash on the URL', async () => {
    const { send } = client({ url: `${stub.url}/` });
    await send(lookalike('speaker', { id: 'a', name: 'b' }, true));
    await send(request);
    expect(received.map((event) => event.path)).toEqual(['/ingest/speakers', '/ingest']);
  });

  it('sends PATCH and DELETE with their bodies', async () => {
    const { send } = client();
    await send({ ...request, method: 'PATCH' });
    await send({ ...request, method: 'DELETE' });
    expect(received.map(({ method, body }) => [method, body])).toEqual([
      ['PATCH', request.body],
      ['DELETE', request.body],
    ]);
  });
});

describe('the request log', () => {
  it('records the request and response without the API key', async () => {
    const { send, log } = client();
    await send(request);

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      label: 'Test',
      method: 'POST',
      url: stub.url,
      body: request.body,
      response: { status: 202 },
    });
    expect(log.entries[0]?.headers.Authorization).toMatch(/^Bearer •+$/);
    expect(JSON.stringify(log.entries)).not.toContain(API_KEY);
  });

  it('keeps the body as sent when the source object changes later', async () => {
    const { send, log } = client();
    const body = { id: 'a', deleted: false };
    await send({ ...request, body });
    body.deleted = true;
    expect(log.entries[0]?.body).toEqual({ id: 'a', deleted: false });
  });

  it('reports additions and clears', async () => {
    const changes: LogChange['kind'][] = [];
    const log = new RequestLog((change) => changes.push(change.kind));
    const { send } = client({ log });
    await send(request);
    log.clear();
    expect(changes).toEqual(['added', 'cleared']);
    expect(log.entries).toEqual([]);
  });

  it('caps how many entries it keeps', () => {
    const log = new RequestLog();
    const entry = { at: '', label: '', method: 'POST', url: '', headers: {}, body: {}, duration_ms: 0 };
    for (let i = 0; i < 510; i++) log.add(entry);
    expect(log.entries).toHaveLength(500);
    expect(log.entries.at(-1)?.id).toBe(510);
  });
});

describe('failures', () => {
  it('logs a non-2xx response instead of throwing', async () => {
    const { send } = client();
    const entry = await send({ ...request, path: 'x'.repeat(256) });
    expect(entry.response?.status).toBe(400);
    expect(entry.error).toBeUndefined();
    expect(received).toEqual([]);
  });

  it('logs a refused connection instead of throwing', async () => {
    const closed = await startStub();
    await closed.close();
    const { send, log } = client({ url: closed.url });

    const entry = await send(request);

    expect(entry.response).toBeUndefined();
    expect(entry.error).toMatch(/ECONNREFUSED|fetch failed/);
    expect(JSON.stringify(log.entries)).not.toContain(API_KEY);
  });
});

describe('the stub', () => {
  const call = (path: string, init: RequestInit) =>
    fetch(stub.url.replace('/ingest', path), {
      ...init,
      headers: { Authorization: 'Bearer k', ...init.headers },
    });

  it('requires an API key', async () => {
    const response = await fetch(stub.url, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });

  it('rejects methods other than writes and deletes', async () => {
    expect((await call('/ingest', { method: 'GET' })).status).toBe(405);
  });

  it('rejects invalid JSON and stores nothing', async () => {
    expect((await call('/ingest', { method: 'POST', body: '{ broken' })).status).toBe(400);
    expect(received).toEqual([]);
  });

  it('accepts a DELETE with no body', async () => {
    const response = await call('/ingest/registrations/reg_1', { method: 'DELETE' });
    expect(response.status).toBe(202);
    expect(received[0]).toMatchObject({ path: '/ingest/registrations/reg_1', body: null });
  });

  it('marks a JSON scalar as malformed', async () => {
    const response = await call('/ingest', { method: 'POST', body: '"just a string"' });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: 'malformed' });
  });

  it('accepts a top-level array', async () => {
    const response = await call('/ingest', { method: 'POST', body: '[{"a":1}]' });
    expect(await response.json()).toMatchObject({ status: 'queued' });
  });

  it('rejects a path segment that decodes to a NUL or invalid UTF-8', async () => {
    expect((await call('/ingest/a%00b', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await call('/ingest/%ff', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('answers 404 outside /ingest', async () => {
    expect((await call('/other', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

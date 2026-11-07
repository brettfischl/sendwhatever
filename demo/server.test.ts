import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIngestClient, RequestLog, type LogEntry } from './ingest-client.js';
import { createDemoServer, SiteEvents } from './server.js';
import { simulateViewers } from './simulate.js';
import { startStub, type Stub, type StubEvent } from './stub.js';
import { Webinar } from './webinar.js';

const API_KEY = 'sw_live_supersecret';

let stub: Stub;
let server: Server;
let base: string;
let webinar: Webinar;
let log: RequestLog;
let received: StubEvent[] = [];

const newSession = {
  title: 'Shipping Schemas',
  description: 'A talk.',
  starts_at: '2026-11-12T17:00:00.000Z',
  timezone: 'America/New_York',
  capacity: 500,
  tags: ['data'],
  speakers: [{ name: 'Priya Raman', title: 'Staff Engineer', company: 'Northwind' }],
  agenda: [
    { duration_minutes: 10, title: 'Welcome', speaker: 'Priya Raman' },
    { duration_minutes: 30, title: 'Main talk' },
  ],
};
const person = { email: 'maya@example.com', first_name: 'Maya', last_name: 'Okafor', marketing_consent: true };

async function post(path: string, body: object = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
const get = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as any;

async function createSession() {
  const { body } = await post('/api/sessions', newSession);
  return body.id as string;
}

beforeAll(async () => {
  stub = await startStub((event) => received.push(event));
  const events = new SiteEvents();
  log = new RequestLog((change) => events.logChanged(change));
  const send = createIngestClient({ url: stub.url, apiKey: API_KEY, accountSlug: 'demo', log });
  webinar = new Webinar(send, (id) => events.sessionChanged(id));
  server = createDemoServer(
    {
      webinar,
      log,
      target: { mode: 'stub', url: stub.url, accountSlug: 'demo' },
      simulatePauseMs: 0,
    },
    events,
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await stub.close();
});

beforeEach(() => {
  received = [];
  log.clear();
});

describe('the journey through the site', () => {
  it('sends the expected request for create, register, watch, comment, and cancel', async () => {
    const created = await post('/api/sessions', newSession);
    expect(created.status).toBe(201);
    const sessionId = created.body.id;
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      path: '/ingest',
      body: {
        id: sessionId,
        status: 'scheduled',
        starts_at: '2026-11-12T12:00:00-05:00',
        ends_at: '2026-11-12T12:40:00-05:00',
        speakers: [{ name: 'Priya Raman' }],
        agenda: [
          { position: 1, title: 'Welcome', starts_at: '2026-11-12T12:00:00-05:00' },
          { position: 2, title: 'Main talk', starts_at: '2026-11-12T12:10:00-05:00' },
        ],
      },
    });
    const speakerId = (received.at(-1)?.body as any).speakers[0].id;
    expect((received.at(-1)?.body as any).agenda[0].speaker_id).toBe(speakerId);

    const registered = await post(`/api/sessions/${sessionId}/registrations`, person);
    const registrationId = registered.body.id;
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      body: { id: registrationId, email: person.email, session: { id: sessionId, title: 'Shipping Schemas' } },
    });

    await post(`/api/sessions/${sessionId}/status`, { status: 'live' });
    expect(received.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { id: sessionId, status: 'live', started_at: expect.any(String) },
    });

    await post(`/api/registrations/${registrationId}/join`);
    expect(received.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { id: registrationId, attendance_status: 'watching', join_count: 1 },
    });

    const posted = await post(`/api/sessions/${sessionId}/comments`, { registration_id: registrationId, body: 'Hello' });
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      body: {
        session_id: sessionId,
        comments: [{ id: posted.body.id, body: 'Hello', author: { name: 'Maya Okafor' }, deleted: false }],
      },
    });

    await post(`/api/comments/${posted.body.id}/remove`);
    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      body: { comments: [{ id: posted.body.id, deleted: true, deleted_at: expect.any(String) }] },
    });

    await post(`/api/registrations/${registrationId}/leave`);
    expect(received.at(-1)).toMatchObject({
      method: 'PATCH',
      body: { id: registrationId, attendance_status: 'left', left_at: expect.any(String) },
    });

    await post(`/api/registrations/${registrationId}/cancel`, { reason: 'schedule_conflict' });
    expect(received.at(-1)).toMatchObject({
      method: 'DELETE',
      body: { id: registrationId, reason: 'schedule_conflict' },
    });

    await post(`/api/sessions/${sessionId}/status`, { status: 'ended' });
    expect(received.at(-1)).toMatchObject({ method: 'PATCH', body: { id: sessionId, status: 'ended' } });

    expect(received).toHaveLength(9);
    expect(received.every((event) => event.headers.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect((await get('/api/log')).length).toBe(9);
  });

  it('gives comments a video offset from when the session really went live', async () => {
    const now = vi.fn(() => new Date('2026-11-07T10:00:00Z'));
    const events: StubEvent[] = [];
    const localStub = await startStub((event) => events.push(event));
    const localWebinar = new Webinar(
      createIngestClient({ url: localStub.url, apiKey: 'k', log: new RequestLog() }),
      () => {},
      now,
    );
    const { id } = await localWebinar.createSession({ ...newSession, starts_at: new Date('2026-12-01T00:00:00Z') });
    const registration = await localWebinar.register(id, person);
    await localWebinar.setStatus(id, 'live');
    await localWebinar.join(registration.id);
    now.mockReturnValue(new Date('2026-11-07T10:02:30Z'));

    const [comment] = await localWebinar.postComments(id, [{ registrationId: registration.id, body: 'Hi' }]);
    await localWebinar.leave(registration.id);
    await localStub.close();

    expect(comment?.video_offset_seconds).toBe(150);
    expect(events.at(-1)?.body).toMatchObject({ watch_seconds: 150 });
  });

  it('routes lookalikes to a path only when the toggle is on', async () => {
    const sessionId = await createSession();
    received = [];
    const add = (kind: string, name: string, use_path: boolean) =>
      post(`/api/sessions/${sessionId}/lookalikes`, { kind, name, use_path });

    await add('speaker', 'Dev Patel', false);
    await add('sponsor', 'Quillstack', false);
    await add('speaker', 'Hana Kim', true);
    await add('sponsor', 'Tallgrass', true);

    expect(received.map((event) => event.path)).toEqual(['/ingest', '/ingest', '/ingest/speakers', '/ingest/sponsors']);
    for (const event of received) {
      expect(Object.keys(event.body as object)).toEqual(['id', 'name']);
    }
    const { session, sponsors } = await get(`/api/sessions/${sessionId}`);
    expect(session.speakers.map((speaker: { name: string }) => speaker.name)).toContain('Hana Kim');
    expect(sponsors.map((sponsor: { name: string }) => sponsor.name)).toEqual(['Quillstack', 'Tallgrass']);
  });

  it('does not resend attendance when nothing changed', async () => {
    const sessionId = await createSession();
    const { body } = await post(`/api/sessions/${sessionId}/registrations`, person);
    await post(`/api/sessions/${sessionId}/status`, { status: 'live' });
    received = [];

    await post(`/api/registrations/${body.id}/leave`);
    await post(`/api/registrations/${body.id}/join`);
    await post(`/api/registrations/${body.id}/join`);
    await post(`/api/registrations/${body.id}/leave`);
    await post(`/api/registrations/${body.id}/leave`);

    expect(received).toHaveLength(2);
  });
});

describe('rules', () => {
  it('rejects actions a session or registration can no longer take', async () => {
    const sessionId = await createSession();
    const { body: registration } = await post(`/api/sessions/${sessionId}/registrations`, person);
    expect((await post(`/api/registrations/${registration.id}/join`)).status).toBe(409);

    await post(`/api/registrations/${registration.id}/cancel`);
    received = [];
    expect((await post(`/api/registrations/${registration.id}/cancel`)).status).toBe(409);
    expect(
      (await post(`/api/sessions/${sessionId}/comments`, { registration_id: registration.id, body: 'Hi' })).status,
    ).toBe(409);

    expect((await post(`/api/sessions/${sessionId}/status`, { status: 'ended' })).status).toBe(409);
    await post(`/api/sessions/${sessionId}/status`, { status: 'cancelled' });
    expect((await post(`/api/sessions/${sessionId}/registrations`, person)).status).toBe(409);
    expect((await post(`/api/sessions/${sessionId}/simulate`, { viewers: 5 })).status).toBe(409);
    expect(received.map((event) => event.method)).toEqual(['PATCH']);
  });

  it('rejects a comment from another session', async () => {
    const first = await createSession();
    const second = await createSession();
    const { body } = await post(`/api/sessions/${first}/registrations`, person);
    expect((await post(`/api/sessions/${second}/comments`, { registration_id: body.id, body: 'Hi' })).status).toBe(400);
  });

  it('validates input', async () => {
    const sessionId = await createSession();
    received = [];
    const register = (body: object) => post(`/api/sessions/${sessionId}/registrations`, body);

    expect((await post('/api/sessions', { ...newSession, title: ' ' })).status).toBe(400);
    expect((await post('/api/sessions', { ...newSession, timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await post('/api/sessions', { ...newSession, starts_at: 'soon' })).status).toBe(400);
    expect((await post('/api/sessions', { ...newSession, speakers: [null] })).status).toBe(400);
    expect((await register({ ...person, email: 'nope' })).status).toBe(400);
    expect((await post(`/api/sessions/${sessionId}/status`, { status: 'scheduled' })).status).toBe(400);
    expect((await post(`/api/sessions/${sessionId}/lookalikes`, { kind: 'venue', name: 'x' })).status).toBe(400);
    expect((await post(`/api/sessions/${sessionId}/simulate`, { viewers: 100000 })).status).toBe(400);
    expect((await post('/api/sessions/ses_missing/status', { status: 'live' })).status).toBe(404);
    expect(received).toEqual([]);
  });

  it('only accepts JSON posts, so a form on another site cannot drive it', async () => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(newSession),
    });
    expect(response.status).toBe(415);
  });

  it('rejects a body that is not valid JSON', async () => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ broken',
    });
    expect(response.status).toBe(400);
  });
});

describe('when ingest fails', () => {
  it('keeps the action and shows the failure in the log', async () => {
    const closed = await startStub();
    await closed.close();
    const localLog = new RequestLog();
    const localWebinar = new Webinar(createIngestClient({ url: closed.url, apiKey: 'k', log: localLog }));

    const { id } = await localWebinar.createSession({ ...newSession, starts_at: new Date() });

    expect(localWebinar.getSession(id).session.id).toBe(id);
    expect(localLog.entries[0]?.error).toBeTruthy();
  });
});

describe('simulating viewers', () => {
  it('generates every kind of activity', async () => {
    const sessionId = await createSession();
    received = [];

    await simulateViewers(webinar, sessionId, { viewers: 20, pauseMs: 0 });

    const bodies = received.map((event) => event.body as Record<string, any>);
    expect(bodies.filter((body) => body.session)).toHaveLength(20);
    expect(bodies.filter((body) => body.attendance_status === 'watching')).toHaveLength(19);
    expect(bodies.filter((body) => body.attendance_status === 'left').length).toBeGreaterThan(0);
    expect(bodies.some((body) => body.status === 'live')).toBe(true);

    const cancellations = received.filter((event) => event.method === 'DELETE');
    expect(cancellations).toHaveLength(1);

    const comments = bodies.flatMap((body) => body.comments ?? []);
    expect(comments.filter((comment) => !comment.deleted)).toHaveLength(19);
    expect(comments.filter((comment) => comment.deleted)).toHaveLength(1);

    const emails = bodies.filter((body) => body.session).map((body) => body.email);
    expect(new Set(emails).size).toBe(20);

    const state = webinar.getSession(sessionId);
    expect(state.session.status).toBe('live');
    expect(state.registrations.filter((r) => r.status === 'cancelled')).toHaveLength(1);
  });

  it('starts through the API and returns before the run finishes', async () => {
    const sessionId = await createSession();
    const { status, body } = await post(`/api/sessions/${sessionId}/simulate`, { viewers: 3 });
    expect(status).toBe(201);
    expect(body).toEqual({ started: true, viewers: 3 });
    await vi.waitFor(() => {
      expect(webinar.getSession(sessionId).comments.length).toBeGreaterThan(0);
    });
  });
});

describe('what the browser can see', () => {
  it('never receives the API key', async () => {
    const sessionId = await createSession();
    await post(`/api/sessions/${sessionId}/registrations`, person);

    const responses = await Promise.all(
      ['/api/meta', '/api/log', '/api/sessions', `/api/sessions/${sessionId}`].map((path) => get(path)),
    );
    expect(JSON.stringify(responses)).not.toContain(API_KEY);
    expect(((await get('/api/log')) as LogEntry[]).length).toBeGreaterThan(0);
  });

  it('pushes log entries and session changes over the stream', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

    await createSession();

    let text = '';
    while (!(text.includes('event: session') && text.includes('event: log'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += value;
    }
    controller.abort();

    expect(text).toContain('event: session');
    expect(text).toContain('event: log\n');
    expect(text).not.toContain(API_KEY);
  });
});

describe('pages', () => {
  it.each([
    ['/', 'text/html'],
    ['/sessions/abc', 'text/html'],
    ['/sessions/abc/watch', 'text/html'],
    ['/assets/app.css', 'text/css'],
    ['/assets/common.js', 'text/javascript'],
    ['/assets/index.js', 'text/javascript'],
    ['/assets/session.js', 'text/javascript'],
    ['/assets/watch.js', 'text/javascript'],
  ])('serves %s', async (path, type) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
  });

  it('serves nothing outside the fixed asset list', async () => {
    for (const path of ['/assets/../server.ts', '/assets/%2e%2e%2fserver.ts', '/assets/index.html', '/server.ts']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
  });
});

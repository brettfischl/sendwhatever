import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRawIngestClient } from './console.js';
import { RequestLog } from './ingest-client.js';
// @ts-expect-error A plain browser module, with no types.
import { createFlowRun, SHAPE_NOTES, stepRequest } from './public/console-flows.js';
// @ts-expect-error A plain browser module, with no types.
import { checkBody, formatJson } from './public/console-format.js';
import { createDemoServer, SiteEvents } from './server.js';
import { orderFlow, productFlow, shopifyFlows } from './shopify/index.js';
import { startStub, type Stub, type StubEvent } from './stub.js';
import type { Webinar } from './webinar.js';

const API_KEY = 'sw_live_console+secret/1';
const JSON_TYPE = { 'Content-Type': 'application/json' };

let stub: Stub;
let server: Server;
let base: string;
let log: RequestLog;
let received: StubEvent[] = [];

async function consoleSend(request: object) {
  const response = await fetch(`${base}/api/console/send`, {
    method: 'POST',
    headers: JSON_TYPE,
    body: JSON.stringify(request),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
}

beforeAll(async () => {
  stub = await startStub((event) => received.push(event));
  log = new RequestLog();
  const options = { url: stub.url, apiKey: API_KEY, accountSlug: 'demo', log };
  server = createDemoServer(
    {
      webinar: {} as Webinar,
      log,
      target: { mode: 'stub', url: stub.url, accountSlug: 'demo' },
      consoleSend: createRawIngestClient(options),
    },
    new SiteEvents(),
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

describe('POST /api/console/send', () => {
  it('sends the exact text, method, path, and headers, adding only auth and the slug', async () => {
    const text = '{"big": 12345678901234567890,\n "a": 1.10}';
    const { status, body } = await consoleSend({
      method: 'PUT',
      path: '/customers/123?region=eu',
      headers: { ...JSON_TYPE, 'X-Device-Fleet': 'greenhouse-4' },
      body: text,
    });

    expect(status).toBe(201);
    expect(body.response.status).toBe(202);
    expect(body.response.statusText).toBe('Accepted');
    expect(body.response.headers['content-type']).toBe('application/json');
    expect(body.response.body).toMatchObject({ status: 'queued' });
    expect(body.url).toBe(`${stub.url}/customers/123?region=eu`);
    expect(body.rawBody).toBe(text);
    expect(body.headers).toEqual({
      Authorization: 'Bearer ••••••••',
      'Content-Type': 'application/json',
      'X-Device-Fleet': 'greenhouse-4',
      'X-Account-Slug': 'demo',
    });

    const [event] = received;
    expect(event).toMatchObject({ method: 'PUT', path: '/ingest/customers/123' });
    expect(event!.headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      'x-device-fleet': 'greenhouse-4',
      'x-account-slug': 'demo',
    });
  });

  it('never adds a Content-Type of its own', async () => {
    await consoleSend({ method: 'POST', body: '{}' });
    expect(received[0]!.headers['content-type']).toBeUndefined();
  });

  it('delivers invalid JSON so ingest can answer 400, and shows exactly what was sent', async () => {
    const { status, body } = await consoleSend({ method: 'POST', headers: JSON_TYPE, body: '{"a": 1,}' });
    expect(status).toBe(201);
    expect(body.response.status).toBe(400);
    expect(body.rawBody).toBe('{"a": 1,}');
    expect(body.body).toBeUndefined();
  });

  it('sends a DELETE with no body', async () => {
    const { body } = await consoleSend({ method: 'DELETE', path: 'customers/123' });
    expect(body.response.status).toBe(202);
    expect(body.rawBody).toBeUndefined();
    expect(received[0]!.body).toBeNull();
  });

  it('puts the key in the URL on request, without an Authorization header', async () => {
    const { text, body } = await consoleSend({ method: 'POST', path: 'shopify?shop=a', body: '{}', auth: 'key' });

    expect(body.response.status).toBe(202);
    expect(body.url).toBe(`${stub.url}/shopify?shop=a&key=••••••••`);
    expect(body.headers.Authorization).toBeUndefined();
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.headers['x-account-slug']).toBe('demo');
    expect(text).not.toContain('sw_live');
    expect(JSON.stringify(log.entries)).not.toContain('sw_live');
  });

  it('builds a working URL from a bare trailing question mark', async () => {
    const { body } = await consoleSend({ method: 'POST', path: 'a?', body: '{}', auth: 'key' });
    expect(body.response.status).toBe(202);
    expect(body.url).toBe(`${stub.url}/a?key=••••••••`);
  });

  it('reports an unreachable ingest as an entry, not a failure', async () => {
    const gone = await startStub();
    await gone.close();
    const sendRaw = createRawIngestClient({ url: gone.url, apiKey: API_KEY, log: new RequestLog() });
    const entry = await sendRaw({ label: 'x', method: 'POST', path: '', headers: {}, body: '{}', auth: 'key' });
    expect(entry.response).toBeUndefined();
    expect(entry.error).toContain('ECONNREFUSED');
    expect(entry.url).not.toContain('sw_live');
  });

  it('keeps a key echoed by ingest out of what goes to the browser', async () => {
    const echoing = new RequestLog();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string) =>
      new Response(`bad url ${input}`, {
        status: 404,
        statusText: `Bad key ${API_KEY}`,
        headers: { 'x-echo': API_KEY },
      })) as typeof fetch;
    try {
      const sendRaw = createRawIngestClient({ url: stub.url, apiKey: API_KEY, log: echoing });
      const entry = await sendRaw({ label: 'x', method: 'POST', path: '', headers: {}, body: '{}', auth: 'key' });
      expect(JSON.stringify(entry)).not.toContain('sw_live');
      expect(JSON.stringify(entry)).not.toContain(encodeURIComponent(API_KEY));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it.each([
    ['a method ingest refuses', { method: 'GET' }, /method/],
    ['a path climbing out', { method: 'POST', path: '../accounts' }, /stay under/],
    ['a path climbing out with encoding', { method: 'POST', path: 'a/%2e%2e/%2E%2e/accounts' }, /stay under/],
    ['a path climbing out with backslashes', { method: 'POST', path: '..\\..\\accounts' }, /stay under/],
    ['a key in the path', { method: 'POST', path: 'a?key=abc' }, /key/],
    ['Authorization', { method: 'POST', headers: { authorization: 'Bearer other' } }, /authorization/],
    ['X-Account-Slug', { method: 'POST', headers: { 'x-account-SLUG': 'other' } }, /x-account-SLUG/],
    ['Content-Length', { method: 'POST', headers: { 'Content-Length': '1' } }, /Content-Length/],
    ['an invalid header name', { method: 'POST', headers: { 'bad name': 'x' } }, /invalid/],
    ['a line break in a header', { method: 'POST', headers: { 'X-A': 'x\r\nX-B: y' } }, /invalid/],
    ['the same header twice', { method: 'POST', headers: { 'X-A': '1', 'x-a': '2' } }, /more than once/],
    ['a body that is not text', { method: 'POST', body: { a: 1 } }, /body/],
    ['an unknown auth', { method: 'POST', auth: 'none' }, /auth/],
  ])('refuses %s without sending anything', async (_, request, message) => {
    const { status, body } = await consoleSend(request);
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
    expect(received).toEqual([]);
    expect(log.entries).toEqual([]);
  });

  it('lets a bad path segment through, so ingest can answer 400', async () => {
    const { status, body } = await consoleSend({ method: 'POST', path: `${'x'.repeat(256)}`, body: '{}' });
    expect(status).toBe(201);
    expect(body.response.status).toBe(400);
  });

  it('serves the page and its assets', async () => {
    for (const path of ['/console', '/assets/console.js', '/assets/console.css', '/assets/console-flows.js', '/assets/console-tables.js']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(200);
    }
  });
});

describe('the stub, for console requests', () => {
  const direct = (path: string, headers: Record<string, string>, body = '{}') =>
    fetch(`${stub.url}${path}`, { method: 'POST', headers, body });

  it('accepts the key in the URL', async () => {
    expect((await direct('/shopify?key=abc', {})).status).toBe(202);
    expect((await direct('/shopify?key=', {})).status).toBe(401);
    expect((await direct('/shopify', {})).status).toBe(401);
  });

  it('answers a repeated delivery with the original event, per source and op', async () => {
    const send = async (path: string, headers: Record<string, string>, method = 'POST') => {
      const response = await fetch(`${stub.url}${path}`, {
        method,
        headers: { Authorization: 'Bearer k', ...headers },
        body: '{}',
      });
      return ((await response.json()) as { event_id: string }).event_id;
    };

    const first = await send('/a', { 'Idempotency-Key': 'one' });
    expect(await send('/a/other', { 'Idempotency-Key': 'one' })).toBe(first);
    expect(received).toHaveLength(1);
    expect(await send('/b', { 'Idempotency-Key': 'one' })).not.toBe(first);
    expect(await send('/a', { 'Idempotency-Key': 'one' }, 'DELETE')).not.toBe(first);

    const shopify = await send('/shopify', { 'X-Shopify-Webhook-Id': 'w1' });
    expect(await send('/shopify', { 'X-Shopify-Webhook-Id': 'w1' })).toBe(shopify);
    expect(await send('/shopify', { 'Idempotency-Key': 'w1' })).toBe(shopify);
  });

  it('treats differently encoded sources as the same source', async () => {
    const send = async (path: string) => {
      const response = await direct(path, { Authorization: 'Bearer k', 'Idempotency-Key': 'enc' });
      return ((await response.json()) as { event_id: string }).event_id;
    };
    expect(await send('/%61')).toBe(await send('/a'));
  });

  it('calls a null DELETE body malformed, but no body fine', async () => {
    const del = async (body?: string) => {
      const response = await fetch(stub.url, { method: 'DELETE', headers: { Authorization: 'Bearer k' }, body });
      return ((await response.json()) as { status: string }).status;
    };
    expect(await del('null')).toBe('malformed');
    expect(await del()).toBe('queued');
  });

  it('refuses an over-long key', async () => {
    const response = await direct('', { Authorization: 'Bearer k', 'Idempotency-Key': 'x'.repeat(256) });
    expect(response.status).toBe(400);
  });
});

describe('checkBody', () => {
  it('accepts objects and arrays', () => {
    expect(checkBody('{"a":1}', 'POST').state).toBe('valid');
    expect(checkBody('[1]', 'POST').state).toBe('valid');
  });

  it('warns that a scalar will be malformed, without blocking it', () => {
    expect(checkBody('42', 'POST').state).toBe('scalar');
    expect(checkBody('null', 'POST').state).toBe('scalar');
  });

  it('allows an empty body only on DELETE', () => {
    expect(checkBody('  \n', 'DELETE').state).toBe('empty');
    expect(checkBody('', 'POST').state).toBe('invalid');
  });

  it('locates the error', () => {
    const check = checkBody('{\n  "a": 1,\n}', 'POST');
    expect(check).toMatchObject({ state: 'invalid', line: 3, column: 1 });
    expect(check.offset).toBe(12);
  });

  it.each([
    ['a bad literal', '{\n  "a": 1,\n  "b": tru,\n  "c": 3\n}', 3, 8],
    ['a trailing comma in a list', '[1,2,]', 1, 6],
    ['a bare word', 'x', 1, 1],
    ['text after the value', '{"a":1}\n  oops', 2, 3],
    ['a missing colon', '{"a" 1}', 1, 6],
    ['an unquoted key', '{\n  a: 1\n}', 2, 3],
    ['a leading zero', '[01]', 1, 3],
    ['a line break in a string', '["a\nb"]', 1, 2],
  ])('locates %s, which V8 words with no position', (_, text, line, column) => {
    const check = checkBody(text, 'POST');
    expect(check).toMatchObject({ state: 'invalid', line, column });
    expect(check.message).not.toContain('is not valid JSON');
  });

  it('points at the end when the text stops early', () => {
    expect(checkBody('{"a":', 'POST')).toMatchObject({ state: 'invalid', line: 1, offset: 5 });
  });
});

describe('formatJson', () => {
  it('indents', () => {
    expect(formatJson('{"a":[1,{"b":null}],"c":{},"d":[]}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": {},\n  "d": []\n}',
    );
  });

  it('leaves values alone, unlike parsing and printing', () => {
    const text = '{"id":12345678901234567890,"price":1.10,"e":1E5,"a":1,"a":2,"s":"x, \\"y\\": [z]"}';
    const formatted = formatJson(text);
    expect(formatted).toContain('12345678901234567890');
    expect(formatted).toContain('1.10');
    expect(formatted).toContain('1E5');
    expect(formatted).toContain('"a": 1,\n  "a": 2');
    expect(formatted).toContain('"x, \\"y\\": [z]"');
  });

  it('is stable, and handles scalars', () => {
    const once = formatJson('[{"a":1}]');
    expect(formatJson(once)).toBe(once);
    expect(formatJson(' 42 ')).toBe('42');
  });
});

describe('the guided flows', () => {
  const getFlows = async () => (await (await fetch(`${base}/api/console/flows`)).json()) as any[];
  const webhookId = (step: { headers: { 'X-Shopify-Webhook-Id': string } }) => step.headers['X-Shopify-Webhook-Id'];
  const sendThroughServer = async (request: object) => {
    const { status, body } = await consoleSend(request);
    if (status !== 201) throw new Error(body.error);
    return body;
  };
  /** A run of the flow at `index`, sending through the demo server to the stub. */
  const startRun = async (index: number, options: object = {}) => {
    const reload = async (id: string) => (await getFlows()).find((flow) => flow.id === id);
    return createFlowRun({ flow: (await getFlows())[index], send: sendThroughServer, reload, ...options });
  };
  const accepted = (event_id: string) => ({ response: { status: 202, body: { status: 'queued', event_id } } });

  it('serves the fixtures, with new delivery IDs each time and the same data', async () => {
    const [first, second] = [await getFlows(), await getFlows()];
    expect(first.map((flow) => flow.steps.map((step: any) => step.topic))).toEqual([
      ['products/create', 'products/update'],
      ['orders/create', 'orders/paid', 'refunds/create'],
    ]);
    first.forEach((flow, f) =>
      flow.steps.forEach((step: any, s: number) => {
        expect(webhookId(step)).not.toBe(webhookId(second[f].steps[s]));
        expect(webhookId(step)).not.toBe(webhookId(shopifyFlows[f]!.steps[s]!));
        expect(step.body).toEqual(second[f].steps[s].body);
      }),
    );
  });

  it('has a note for every topic', () => {
    for (const flow of shopifyFlows) {
      for (const step of flow.steps) expect(SHAPE_NOTES[step.topic], step.topic).toBeTruthy();
    }
  });

  it('builds the request from a step, adding Content-Type only if it is missing', () => {
    const [step] = productFlow.steps;
    const request = stepRequest(step);
    expect(request).toMatchObject({ method: 'POST', path: 'shopify', auth: 'key', headers: step.headers });
    expect(JSON.parse(request.body)).toEqual(step.body);

    const { 'Content-Type': _, ...others } = step.headers;
    expect(stepRequest({ ...step, headers: others }).headers['Content-Type']).toBe('application/json');
    const lower = stepRequest({ ...step, headers: { ...others, 'content-type': 'text/plain' } }).headers;
    expect(lower['content-type']).toBe('text/plain');
    expect(lower['Content-Type']).toBeUndefined();
  });

  it('sends the order flow in order, one step at a time, with its headers and the key in the URL', async () => {
    const run = await startRun(1);
    expect(run.stepStatus(0)).toBe('next');
    expect(run.stepStatus(1)).toBe('later');

    for (const index of [0, 1, 2]) {
      expect(run.state.next).toBe(index);
      await run.sendNext();
      expect(run.stepStatus(index)).toBe('delivered');
      expect(received).toHaveLength(index + 1);
    }
    expect(run.isDone()).toBe(true);
    await run.sendNext();

    expect(received.map((event) => event.headers['x-shopify-topic'])).toEqual(orderFlow.steps.map((step) => step.topic));
    received.forEach((event, index) => {
      const step = run.state.flow.steps[index];
      expect(event.path).toBe('/ingest/shopify');
      expect(event.body).toEqual(step.body);
      expect(event.headers.authorization).toBeUndefined();
      expect(event.headers['content-type']).toBe('application/json');
      expect(event.headers['x-shopify-webhook-id']).toBe(webhookId(step));
      expect(event.headers['x-shopify-hmac-sha256']).toBe(step.headers['X-Shopify-Hmac-Sha256']);
      expect(run.state.outcomes[index].eventId).toBe(event.event_id);
    });
    for (const entry of log.entries) {
      expect(entry.url).toMatch(/\/ingest\/shopify\?key=•+$/);
      expect(entry.headers.Authorization).toBeUndefined();
    }
  });

  it('counts a run after a reset as new deliveries', async () => {
    const run = await startRun(0);
    await run.sendNext();
    const firstEvent = run.state.outcomes[0].eventId;

    await run.reset();
    expect(run.state.next).toBe(0);
    expect(run.state.outcomes).toEqual([]);
    await run.sendNext();

    expect(received).toHaveLength(2);
    expect(run.state.outcomes[0].eventId).not.toBe(firstEvent);
    expect(received[0]!.headers['x-shopify-webhook-id']).not.toBe(received[1]!.headers['x-shopify-webhook-id']);
  });

  it('gets the original event_id back for the same delivery, without moving the flow on', async () => {
    const run = await startRun(0);
    await run.resend();
    expect(received).toHaveLength(0);

    await run.sendNext();
    await run.resend();
    await run.resend();

    expect(received).toHaveLength(1);
    expect(run.state.next).toBe(1);
    expect(run.state.resends[0]).toMatchObject({ kind: 'same', count: 2 });
    expect(log.entries).toHaveLength(3);
  });

  it('says so if the same delivery comes back with another event_id or fails', async () => {
    const replies = [accepted('first'), accepted('second')];
    const run = createFlowRun({ flow: productFlow, send: async () => replies.shift(), reload: async () => productFlow });
    await run.sendNext();
    await run.resend();
    expect(run.state.resends[0]).toMatchObject({ kind: 'different', eventId: 'second' });

    replies.push({ response: { status: 503, body: { error: 'down' } } } as any);
    await run.resend();
    expect(run.state.resends[0]).toMatchObject({ kind: 'fail', count: 2, summary: 'Ingest answered 503. down' });
    expect(run.state.next).toBe(1);
  });

  it('auto-plays to the end with a visible pause between steps, and none after the last', async () => {
    const pauses: number[] = [];
    const sent: string[] = [];
    let lastResume: number | null = null;
    const run = createFlowRun({
      flow: orderFlow,
      pauseMs: 5,
      reload: async () => orderFlow,
      send: async (request: { headers: Record<string, string> }) => {
        sent.push(request.headers['X-Shopify-Topic']!);
        return accepted('id');
      },
      onChange: () => {
        const { resumesAt } = run.state;
        if (resumesAt !== null && resumesAt !== lastResume) pauses.push(sent.length);
        lastResume = resumesAt;
      },
    });
    await run.play();
    expect(sent).toEqual(orderFlow.steps.map((step) => step.topic));
    expect(pauses).toEqual([1, 2]);
    expect(run.state.playing).toBe(false);
    expect(run.state.resumesAt).toBeNull();
  });

  it('stops auto-play on request, during the pause, and when it may not continue', async () => {
    const send = async () => accepted('id');
    const stopped = createFlowRun({
      flow: orderFlow,
      pauseMs: 60_000,
      send,
      reload: async () => orderFlow,
      onChange: () => {
        if (stopped.state.resumesAt !== null && stopped.state.playing) stopped.stop();
      },
    });
    await stopped.play();
    expect(stopped.state.next).toBe(1);
    expect(stopped.state.playing).toBe(false);

    let allowed = true;
    const hidden = createFlowRun({ flow: orderFlow, pauseMs: 1, send, reload: async () => orderFlow, canContinue: () => allowed });
    const playing = hidden.play();
    allowed = false;
    await playing;
    expect(hidden.state.next).toBe(1);
  });

  it('stops auto-play at a failure, keeps that step next, and retries the same delivery', async () => {
    const ids: string[] = [];
    const replies: any[] = [
      accepted('one'),
      { response: { status: 500, body: { error: 'boom' } } },
      accepted('two'),
    ];
    const run = createFlowRun({
      flow: orderFlow,
      pauseMs: 1,
      reload: async () => orderFlow,
      send: async (request: { headers: Record<string, string> }) => {
        ids.push(request.headers['X-Shopify-Webhook-Id']!);
        return replies.shift();
      },
    });
    await run.play();
    expect(run.state.playing).toBe(false);
    expect(run.state.next).toBe(1);
    expect(run.stepStatus(1)).toBe('failed');
    expect(run.state.outcomes[1].summary).toBe('Ingest answered 500. boom');

    await run.sendNext();
    expect(run.stepStatus(1)).toBe('delivered');
    expect(ids[2]).toBe(ids[1]);
  });

  it('reports a refused request, no response, a redirect, a reply with no event_id, and a malformed body as failures', async () => {
    const results: any[] = [
      () => Promise.reject(new Error('reserved header')),
      () => Promise.resolve({ error: 'connection refused' }),
      () => Promise.resolve({ response: { status: 302, body: '' } }),
      () => Promise.resolve({ response: { status: 200, body: '<html>a proxy</html>' } }),
      () => Promise.resolve({ response: { status: 202, body: { status: 'malformed', event_id: 'id' } } }),
    ];
    const run = createFlowRun({ flow: productFlow, send: () => results.shift()(), reload: async () => productFlow });
    const summaries = [];
    for (let i = 0; i < 5; i += 1) {
      await run.sendNext();
      summaries.push(run.state.outcomes[0].summary);
    }
    expect(summaries).toEqual([
      'Not sent. reserved header',
      'No response from ingest. connection refused',
      'Ingest answered 302.',
      'Ingest answered 200 with no event_id, so this may not be ingest.',
      'Ingest answered 202, but logged the body as malformed.',
    ]);
    expect(run.state.next).toBe(0);
  });

  it('keeps the run as it was if starting over fails', async () => {
    const run = createFlowRun({
      flow: productFlow,
      send: async () => accepted('id'),
      reload: async () => {
        throw new Error('server gone');
      },
    });
    await run.sendNext();
    await run.reset();
    expect(run.state.next).toBe(1);
    expect(run.state.problem).toBe("Couldn't start over. server gone");
    expect(run.state.busy).toBeNull();
  });
});

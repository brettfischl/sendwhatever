import { describe, expect, it } from 'vitest';
import type { AdapterRequest, IntermediateObject } from '../src/contracts/index.js';
import { runAdapter, type SandboxFailureKind, type SandboxLimits, type SandboxResult } from '../src/sandbox/index.js';

const REQUEST: AdapterRequest = {
  method: 'POST',
  path: '/ingest/users',
  query: 'a=1',
  headers: { 'content-type': 'application/json' },
};

function run(code: string, body: string | null = '{}', limits?: SandboxLimits): Promise<SandboxResult> {
  return runAdapter({ code, body, request: REQUEST }, limits);
}

/** Runs an expression as the body of `adapt` and returns the expression's value. */
async function evaluate(expression: string, body?: string | null): Promise<unknown> {
  const result = await run(`function adapt(payload) { return (${expression}); }`, body);
  if (!result.ok) throw new Error(`${result.kind}: ${result.detail}`);
  return result.output;
}

function expectFailure(result: SandboxResult, kind: SandboxFailureKind): string {
  expect(result).toMatchObject({ ok: false, kind });
  return result.ok ? '' : result.detail;
}

const ADAPTER_FROM_PRD = `
function adapt(payload) {
  const data = payload.data;
  return {
    table: 'user',
    rows: Array.isArray(data) ? data.map(normalize) : [normalize(data)]
  };

  function normalize(item) {
    return {
      id: item.id,
      ...('email' in item ? { email: item.email } : {}),
      children: item.profile ? {
        profile: {
          rows: [{
            ...field(item.profile, 'first_name', 'firstName', 'first_name'),
            ...field(item.profile, 'last_name', 'lastName', 'last_name')
          }]
        }
      } : undefined
    };
  }

  function field(source, column, ...keys) {
    const key = keys.find((name) => name in source);
    return key ? { [column]: source[key] } : {};
  }
}`;

describe('running an adapter', () => {
  it('returns an IntermediateObject from the adapter in the PRD', async () => {
    const body = JSON.stringify({ id: 'u1', email: 'ada@example.com', profile: { firstName: 'Ada' } });
    const result = await run(ADAPTER_FROM_PRD, body);
    if (!result.ok) throw new Error(result.detail);

    const output = result.output as IntermediateObject;
    expect(output).toEqual({
      table: 'user',
      rows: [
        {
          id: 'u1',
          email: 'ada@example.com',
          children: { profile: { rows: [{ first_name: 'Ada' }] } },
        },
      ],
    });
  });

  it('returns an array of IntermediateObjects', async () => {
    expect(await evaluate(`[{ table: 'a', rows: [] }, { table: 'b', rows: [{ x: 1 }] }]`)).toEqual([
      { table: 'a', rows: [] },
      { table: 'b', rows: [{ x: 1 }] },
    ]);
  });

  it('passes the logged request to the adapter', async () => {
    expect(await evaluate('payload.request')).toEqual(REQUEST);
  });

  it('accepts adapt declared with const or in strict mode', async () => {
    expect(await run('const adapt = () => 1;')).toEqual({ ok: true, output: 1 });
    expect(await run('"use strict"; function adapt() { return 2; }')).toEqual({ ok: true, output: 2 });
  });

  it('handles code that ends in a line comment', async () => {
    expect(await run('function adapt() { return 1; } // done')).toEqual({ ok: true, output: 1 });
  });

  it('copies strings exactly, including lone surrogates', async () => {
    const text = 'quote " slash \\ newline \n NUL \u0000 emoji 😀 lone \ud800';
    expect(await evaluate('payload.data.text', JSON.stringify({ text }))).toBe(text);
  });
});

describe('reading the body', () => {
  it('passes integers beyond the safe range as strings and leaves the rest as numbers', async () => {
    const body = `{
      "huge": 12345678901234567890,
      "negative": -9007199254740993,
      "firstUnsafe": 9007199254740992,
      "maxSafe": 9007199254740991,
      "minSafe": -9007199254740991,
      "fraction": 1.5,
      "exponent": 1e30,
      "nested": [{ "id": 98765432109876543210 }]
    }`;
    expect(await evaluate('payload.data', body)).toEqual({
      huge: '12345678901234567890',
      negative: '-9007199254740993',
      firstUnsafe: '9007199254740992',
      maxSafe: 9007199254740991,
      minSafe: -9007199254740991,
      fraction: 1.5,
      exponent: 1e30,
      nested: [{ id: '98765432109876543210' }],
    });
  });

  it('shows the adapter a large integer as a string', async () => {
    expect(await evaluate('typeof payload.data[0]', '[12345678901234567890]')).toBe('string');
  });

  it('gives data as null when there is no body', async () => {
    expect(await evaluate('payload.data', null)).toBeNull();
    expect(await evaluate('payload.data', '')).toBeNull();
  });

  it('reports an invalid body as the body being at fault', async () => {
    expectFailure(await run('function adapt() { return 1; }', '{nope'), 'invalid_body');
  });

  it('reports a body too deeply nested to parse, rather than crashing', async () => {
    const deep = '['.repeat(200_000) + ']'.repeat(200_000);
    expectFailure(await run('function adapt() { return 1; }', deep), 'invalid_body');
  });

  it('keeps a __proto__ key in the body from setting a prototype', async () => {
    const body = '{"__proto__": {"polluted": true}}';
    expect(await evaluate('[payload.data.polluted, ({}).polluted, Object.keys(payload.data)]', body)).toEqual([
      undefined,
      undefined,
      ['__proto__'],
    ]);
  });
});

describe('copying the output out', () => {
  it('tells a column set to undefined from a missing key', async () => {
    const output = (await evaluate(`{ table: 't', rows: [{ id: 'a', cleared: undefined, kept_null: null }] }`)) as {
      rows: Record<string, unknown>[];
    };
    const row = output.rows[0]!;
    expect(Object.keys(row).sort()).toEqual(['cleared', 'id', 'kept_null']);
    expect('cleared' in row).toBe(true);
    expect(row.cleared).toBeUndefined();
    expect(row.kept_null).toBeNull();
    expect('absent' in row).toBe(false);
  });

  it('keeps a top-level undefined and undefined inside an array', async () => {
    expect(await evaluate('undefined')).toBeUndefined();
    const items = (await evaluate('[undefined, 1, undefined]')) as unknown[];
    expect(items).toHaveLength(3);
    expect(items[0]).toBeUndefined();
  });

  it('keeps NaN and the infinities, for the gate to reject', async () => {
    const output = (await evaluate('{ nan: NaN, inf: Infinity, neg: -Infinity, zero: -0, big: 1e308 }')) as Record<
      string,
      number
    >;
    expect(output.nan).toBeNaN();
    expect(output.inf).toBe(Infinity);
    expect(output.neg).toBe(-Infinity);
    expect(Object.is(output.zero, -0)).toBe(true);
    expect(output.big).toBe(1e308);
  });

  it('turns an Infinity from an oversized number in the body into a rejectable value, not null', async () => {
    expect(await evaluate('payload.data[0]', '[1e400]')).toBe(Infinity);
  });

  it('does not treat data shaped like the encoding as anything but data', async () => {
    const shaped = '{ a: ["u"], b: ["n"], c: ["o", "x", 1], d: "u" }';
    expect(await evaluate(shaped)).toEqual({ a: ['u'], b: ['n'], c: ['o', 'x', 1], d: 'u' });
  });

  it('delivers plain host objects with no functions or accessors', async () => {
    const output = (await evaluate(`{ nested: { list: [{ a: 1 }] }, nullProto: Object.create(null) }`)) as {
      nested: { list: Record<string, number>[] };
      nullProto: object;
    };
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(output.nullProto)).toBe(Object.prototype);
    expect(Array.isArray(output.nested.list)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(output.nested, 'list')).toMatchObject({ writable: true, enumerable: true });
  });

  it('copies a __proto__ key as data without polluting the host', async () => {
    const output = (await evaluate(`JSON.parse('{"__proto__": {"polluted": true}}')`)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a getter, without running it', async () => {
    const detail = expectFailure(
      await run(`function adapt() { return { rows: [{ get x() { while (true) {} } }] }; }`, '{}', { timeoutMs: 200 }),
      'invalid_output',
    );
    expect(detail).toContain('$.rows[0].x');
  });

  it.each([
    ['a function', '{ f() {} }'],
    ['a symbol', '{ s: Symbol("x") }'],
    ['a bigint', '{ n: 1n }'],
    ['a Date', '{ d: new Date(0) }'],
    ['a Map', '{ m: new Map() }'],
    ['a class instance', 'new (class A { x = 1 })()'],
    ['an object inheriting data', 'Object.create({ inherited: 1 })'],
    ['a typed array', 'new Uint8Array(4)'],
    ['a boxed string', 'new String("x")'],
    ['a symbol key', '{ [Symbol("k")]: 1 }'],
    ['a non-enumerable property', 'Object.defineProperty({}, "x", { value: 1 })'],
    ['an array with a named property', 'Object.assign([], { extra: 1 })'],
    ['an array with a key past the index range', 'Object.assign([], { 4294967295: 1 })'],
    ['an array with a non-enumerable item', 'Object.defineProperty([], "0", { value: 1, enumerable: false })'],
    ['an array subclass', 'new (class L extends Array {})()'],
    ['a promise', 'Promise.resolve(1)'],
  ])('refuses %s', async (_name, expression) => {
    expectFailure(await run(`function adapt() { return (${expression}); }`), 'invalid_output');
  });

  it('refuses an async adapter, because it returns a promise', async () => {
    expectFailure(await run('async function adapt() { return { table: "t", rows: [] }; }'), 'invalid_output');
  });

  it('refuses circular output', async () => {
    const detail = expectFailure(
      await run('function adapt() { const a = {}; a.self = a; return a; }'),
      'invalid_output',
    );
    expect(detail).toMatch(/circular/);
  });

  it('survives output nested past the depth limit', async () => {
    const code = 'function adapt() { let a = []; for (let i = 0; i < 1e5; i++) a = [a]; return a; }';
    expectFailure(await run(code), 'invalid_output');
  });

  it('accepts output nested up to a reasonable depth', async () => {
    const code = 'function adapt() { let a = []; for (let i = 0; i < 200; i++) a = [a]; return a; }';
    expect((await run(code)).ok).toBe(true);
  });

  it('copies large output', async () => {
    const output = (await evaluate(`Array.from({ length: 200000 }, (_, i) => ({ i }))`)) as { i: number }[];
    expect(output).toHaveLength(200000);
    expect(output[199999]).toEqual({ i: 199999 });
  });

  it('still encodes correctly when the adapter tampers with every builtin', async () => {
    const code = `
      function adapt() {
        const result = { table: 't', rows: [{ id: 'a', gone: undefined, list: [1, 2] }] };
        Object.defineProperty(Array.prototype, '0', { set() { throw new Error('hijacked'); }, configurable: true });
        Object.prototype.toJSON = () => 'hijacked';
        Array.prototype.toJSON = () => 'hijacked';
        String.prototype.toJSON = () => 'hijacked';
        Object.prototype.get = () => 'hijacked';
        Object.prototype.value = 'hijacked';
        Array.prototype[Symbol.iterator] = function () { throw new Error('hijacked'); };
        JSON.stringify = () => 'hijacked';
        JSON.parse = () => 'hijacked';
        Reflect.ownKeys = () => [];
        Reflect.getOwnPropertyDescriptor = () => ({ value: 'hijacked' });
        Reflect.getPrototypeOf = () => null;
        Object.hasOwn = () => false;
        Array.isArray = () => false;
        globalThis.String = () => 'hijacked';
        Function.prototype.call = () => 'hijacked';
        Function.prototype.apply = () => 'hijacked';
        return result;
      }`;
    const result = await run(code);
    expect(result).toEqual({ ok: true, output: { table: 't', rows: [{ id: 'a', gone: undefined, list: [1, 2] }] } });
    if (result.ok) {
      const row = (result.output as IntermediateObject).rows[0]!;
      expect('gone' in row).toBe(true);
    }
  });
});

describe('removed APIs', () => {
  it('removes Date.now and Math.random', async () => {
    expect(await evaluate('[typeof Date.now, typeof Math.random]')).toEqual(['undefined', 'undefined']);
    expect(expectFailure(await run('function adapt() { return Date.now(); }'), 'threw')).toMatch(/TypeError/);
    expect(expectFailure(await run('function adapt() { return Math.random(); }'), 'threw')).toMatch(/TypeError/);
  });

  it.each([
    ['new Date()', 'new Date()'],
    ['Date() as a function', 'Date()'],
    ['spread with no arguments', 'new Date(...[])'],
    ['Reflect.construct', 'Reflect.construct(Date, [])'],
    ['a subclass', 'new (class D extends Date { constructor() { super(); } })()'],
    ['the prototype constructor', 'new (new Date(0).constructor)()'],
    ['the constructor found through a prototype', 'new (Object.getPrototypeOf(new Date(0)).constructor)()'],
  ])('blocks reading the clock through %s', async (_name, expression) => {
    const detail = expectFailure(await run(`function adapt() { return (${expression}).valueOf(); }`), 'threw');
    expect(detail).toMatch(/clock is not available/);
  });

  it('keeps new Date(value) and the rest of Date working', async () => {
    expect(
      await evaluate(`[
        new Date('2026-01-02T03:04:05Z').toISOString(),
        new Date(0).getTime(),
        new Date(2026, 0, 2).getUTCDate(),
        new Date(new Date(5)).getTime(),
        Date.UTC(2026, 0, 1),
        Date.parse('2026-01-01T00:00:00Z'),
        new Date(0) instanceof Date,
        new (class D extends Date { twice() { return this.getTime() * 2; } })(21).twice(),
      ]`),
    ).toEqual([
      '2026-01-02T03:04:05.000Z',
      0,
      2,
      5,
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 1),
      true,
      42,
    ]);
  });

  it('fixes the timezone and locale, so output does not depend on the host', async () => {
    expect(await evaluate(`[new Date(0).getHours(), new Date(0).getTimezoneOffset(), (1234.5).toLocaleString()]`)).toEqual(
      [0, 0, '1,234.5'],
    );
  });

  it('produces identical output across runs of an adapter using what remains', async () => {
    const code = `function adapt() { return { at: new Date(1e12).toISOString(), order: [3, 1, 2].sort(), stack: new Error('x').stack }; }`;
    expect(await run(code)).toEqual(await run(code));
  });
});

describe('isolation from the host', () => {
  it('exposes only standard builtins as globals', async () => {
    const names = (await evaluate('Object.getOwnPropertyNames(globalThis)')) as string[];
    const standard = new Set(
      `Object Function Array Number Boolean String Symbol BigInt Date Promise RegExp Map Set WeakMap WeakSet Iterator
       Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError
       ArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array
       Float32Array Float64Array BigInt64Array BigUint64Array JSON Math Reflect
       parseFloat parseInt isNaN isFinite eval encodeURI encodeURIComponent decodeURI decodeURIComponent escape unescape
       globalThis Infinity NaN undefined`.split(/\s+/),
    );
    expect(names.filter((name) => !standard.has(name))).toEqual(['adapt']);
  });

  it.each([
    'process', 'require', 'module', 'global', 'Buffer', 'console', 'fetch', 'setTimeout', 'setInterval',
    'queueMicrotask', 'performance', 'crypto', 'XMLHttpRequest', 'WebSocket', 'WebAssembly', 'SharedArrayBuffer',
    'Atomics', 'WeakRef', 'FinalizationRegistry', 'Intl', 'Proxy', '_ivm', 'ivm', 'run',
  ])('does not expose %s', async (name) => {
    expect(await evaluate(`typeof ${name}`)).toBe('undefined');
  });

  it.each([
    ['the object constructor chain', `({}).constructor.constructor('return typeof process')()`],
    ['a function constructor chain', `(function () {}).constructor('return typeof process')()`],
    ['an arrow function chain', `(() => {}).constructor('return typeof require')()`],
    ['an async function chain', `(async () => {}).constructor`],
    ['a generator function chain', `(function* () {}).constructor('return typeof process')().next().value`],
    ['this from a sloppy function', `(function () { return typeof this.process; })()`],
    ['indirect eval', `(0, eval)('typeof process')`],
    ['the payload constructor chain', `payload.constructor.constructor('return typeof process')()`],
    ['the data constructor chain', `payload.data.constructor.constructor('return typeof require')()`],
    ['the request constructor chain', `payload.request.headers.constructor.constructor('return typeof process')()`],
    ['an error constructor chain', `new Error('x').constructor.constructor('return typeof process')()`],
  ])('reaches nothing through %s', async (name, expression) => {
    const value = await run(`function adapt(payload) { const v = ${expression}; return typeof v === 'function' ? 'undefined' : v; }`);
    expect(value, name).toEqual({ ok: true, output: 'undefined' });
  });

  it('gives the payload objects from the sandbox, not the host', async () => {
    expect(
      await evaluate(`[
        Object.getPrototypeOf(payload) === Object.prototype,
        Object.getPrototypeOf(payload.request) === Object.prototype,
        Object.getPrototypeOf(payload.data) === Object.prototype,
        payload.constructor === Object,
      ]`),
    ).toEqual([true, true, true, true]);
  });

  it('keeps the runner out of reach of the call stack', async () => {
    const code = `
      function adapt() {
        const found = [];
        found.push(adapt.caller === null);
        found.push(typeof arguments.callee.caller);
        Error.prepareStackTrace = (_error, sites) => sites.map((site) => typeof site.getFunction());
        const holder = {};
        Error.captureStackTrace(holder);
        const stack = holder.stack;
        Error.prepareStackTrace = undefined;
        return { found, frames: stack.slice(1) };
      }`;
    const result = await run(code);
    expect(result).toMatchObject({ ok: true, output: { found: [true, 'object'] } });
    if (result.ok) {
      const { frames } = result.output as { frames: string[] };
      expect(frames.every((type) => type === 'undefined')).toBe(true);
    }
  });

  it('does not carry state from one run to the next', async () => {
    const first = `
      globalThis.leaked = 1;
      Object.prototype.leaked = 1;
      Array.prototype.map = () => 'hijacked';
      function adapt() { return globalThis.leaked; }`;
    expect(await run(first)).toEqual({ ok: true, output: 1 });
    expect(await evaluate(`[typeof leaked, ({}).leaked, [1].map((x) => x + 1)]`)).toEqual([
      'undefined',
      undefined,
      [2],
    ]);
  });

  it('does not pollute the host through a thrown error or its output', async () => {
    await run(`function adapt() { Object.prototype.polluted = 1; throw new Error('x'); }`);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('failure kinds', () => {
  it('reports a syntax error with its position', async () => {
    const detail = expectFailure(await run('function adapt( {\n  return 1;\n}'), 'syntax_error');
    expect(detail).toMatch(/Unexpected/);
    expect(detail).toMatch(/adapter\.js:\d+/);
  });

  it('reports a syntax error that quotes a timeout message as a syntax error', async () => {
    expectFailure(await run('const r = /timed out(/; function adapt() { return 1; }'), 'syntax_error');
  });

  it.each([
    ['a huge message', `new Error('x'.repeat(2 ** 29 - 24))`],
    ['a message that doubles when escaped', `new Error('\\\\'.repeat(2 ** 28))`],
    ['a huge string', `'x'.repeat(2 ** 29 - 24)`],
  ])('reports a throw of %s, without overflowing', async (_name, thrown) => {
    const detail = expectFailure(await run(`function adapt() { throw ${thrown}; }`, '{}', { memoryLimitMb: 1024 }), 'threw');
    expect(detail.length).toBeLessThanOrEqual(2000);
  });

  it('does not run code that fails to parse', async () => {
    expectFailure(await run('while (true) {}\nfunction ('), 'syntax_error');
  });

  it('reports code with no adapt function', async () => {
    expectFailure(await run('const other = 1;'), 'no_adapter');
    expectFailure(await run('const adapt = 1;'), 'no_adapter');
    expectFailure(await run(''), 'no_adapter');
  });

  it('reports a throw with the name and message', async () => {
    const detail = expectFailure(await run(`function adapt() { throw new TypeError('bad field'); }`), 'threw');
    expect(detail).toBe('TypeError: bad field');
  });

  it('reports a throw at the top level', async () => {
    expect(expectFailure(await run(`throw new RangeError('at load');`), 'threw')).toBe('RangeError: at load');
  });

  it('reports a thrown non-Error', async () => {
    expect(expectFailure(await run(`function adapt() { throw 'text'; }`), 'threw')).toBe('text');
    expect(expectFailure(await run(`function adapt() { throw Symbol('s'); }`), 'threw')).toBe('Symbol(s)');
    expect(expectFailure(await run(`function adapt() { throw null; }`), 'threw')).toBe('null');
    expect(expectFailure(await run(`function adapt() { throw {}; }`), 'threw')).toMatch(/not an Error/);
  });

  it('does not run a getter on a thrown value', async () => {
    const code = `function adapt() { throw { get message() { while (true) {} } }; }`;
    expectFailure(await run(code, '{}', { timeoutMs: 200 }), 'threw');
  });

  it('reports a stack overflow as a throw', async () => {
    const detail = expectFailure(await run('function adapt() { return adapt(); }'), 'threw');
    expect(detail).toMatch(/call stack/);
  });

  it('truncates a very long error message', async () => {
    const detail = expectFailure(await run(`function adapt() { throw new Error('x'.repeat(1e6)); }`), 'threw');
    expect(detail.length).toBeLessThanOrEqual(2000);
  });

  it('cannot forge a timeout or memory failure by throwing the engine message', async () => {
    for (const message of ['Script execution timed out.', 'Isolate was disposed during execution due to memory limit']) {
      const code = `function adapt() { throw new Error(${JSON.stringify(message)}); }`;
      expect(expectFailure(await run(code), 'threw')).toContain(message);
    }
  });
});

describe('promises left rejected', () => {
  it('keeps the returned output', async () => {
    const code = `function adapt() { Promise.reject(new Error('boom')); return 1; }`;
    expect(await run(code)).toEqual({ ok: true, output: 1 });
  });

  it('cannot forge a timeout or memory failure', async () => {
    for (const message of ['Script execution timed out.', 'Isolate was disposed during execution due to memory limit']) {
      const code = `function adapt() { Promise.reject(new Error(${JSON.stringify(message)})); return 1; }`;
      expect(await run(code)).toEqual({ ok: true, output: 1 });
    }
  });

  it('reports an async adapter that rejects as returning a promise', async () => {
    const code = `async function adapt() { throw new Error('Script execution timed out.'); }`;
    expectFailure(await run(code), 'invalid_output');
  });

  it('keeps the output when a getter on the rejected value finishes', async () => {
    const code = `function adapt() { Promise.reject({ get message() { return 'x'; } }); return 1; }`;
    expect(await run(code)).toEqual({ ok: true, output: 1 });
  });

  it('kills a getter on the rejected value that never finishes', async () => {
    const code = `function adapt() { Promise.reject({ get message() { for (;;); } }); return 1; }`;
    const started = Date.now();
    expectFailure(await run(code, '{}', { timeoutMs: 100, killGraceMs: 300 }), 'timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('limits', () => {
  it.each([
    ['an infinite loop', 'while (true) {}'],
    ['an infinite loop at the top level', ''],
    ['catastrophic regex backtracking', `/(a+)+$/.test('a'.repeat(40) + 'b');`],
    ['an endless microtask chain', `const f = () => Promise.resolve().then(f); f(); return 1;`],
    ['a blocked microtask', `Promise.resolve().then(() => { while (true) {} }); return 1;`],
    ['an endless async function', `(async () => { while (true) await null; })(); return 1;`],
    ['a loop that catches everything', `while (true) { try { while (true) {} } catch {} }`],
  ])('times out %s', async (name, body) => {
    const code = name.includes('top level') ? 'while (true) {}\nfunction adapt() {}' : `function adapt() { ${body} }`;
    const started = Date.now();
    expectFailure(await run(code, '{}', { timeoutMs: 100 }), 'timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('kills a run that V8 cannot interrupt', async () => {
    // Flattening this string doesn't check for termination, so only the kill can stop it in time.
    const code = `function adapt() { return JSON.stringify('x'.repeat(2 ** 29 - 24)).length; }`;
    const result = await run(code, '{}', { timeoutMs: 50, killGraceMs: 100 });
    expectFailure(result, 'timeout');
  });

  // Several of these abort the whole process rather than trip the isolate's limit, which is why the
  // sandbox runs in a child process. Each one must leave this process running.
  it.each([
    ['growing an array of arrays', 'const a = []; while (true) a.push(new Array(1e6).fill(0));'],
    ['growing an array of objects', 'const a = []; for (;;) a.push({});'],
    ['growing a Map', 'const m = new Map(); for (let i = 0; ; i++) m.set(i, i);'],
    ['growing a Set', 'const s = new Set(); for (let i = 0; ; i++) s.add(i);'],
    ['filling a huge array', 'new Array(2 ** 29).fill(0);'],
    ['Array.from with a huge length', 'Array.from({ length: 2 ** 28 }, (_, i) => i);'],
    ['spreading a huge array', '[...new Array(2 ** 29)];'],
    ['concatenating an array to itself', 'let a = [1]; while (true) a = a.concat(a);'],
  ])('stops memory exhaustion from %s', async (_name, body) => {
    const started = Date.now();
    const result = await run(`function adapt() { ${body} }`, '{}', { memoryLimitMb: 32, timeoutMs: 3000 });
    expectFailure(result, 'memory_limit');
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it.each([
    ['a huge ArrayBuffer', 'new ArrayBuffer(2 ** 40);'],
    ['a huge typed array', 'new Float64Array(2 ** 30);'],
    ['many large ArrayBuffers', 'const b = []; while (true) b.push(new ArrayBuffer(1e8));'],
    ['doubling a string', 'let s = "x"; while (true) s += s;'],
  ])('refuses %s with a catchable error', async (_name, body) => {
    const detail = expectFailure(await run(`function adapt() { ${body} }`, '{}', { memoryLimitMb: 32 }), 'threw');
    expect(detail).toMatch(/RangeError/);
  });

  it('cannot get past the memory limit by catching the error', async () => {
    const code = `function adapt() {
      const a = [];
      while (true) { try { a.push(new Array(1e6).fill(0)); } catch {} }
    }`;
    const result = await run(code, '{}', { memoryLimitMb: 32, timeoutMs: 3000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['memory_limit', 'timeout']).toContain(result.kind);
  });

  it('reports output too large for memory as a failure', async () => {
    const code = `function adapt() { const s = 'x'.repeat(1e6); return Array.from({ length: 5000 }, () => [s, s + 'y']); }`;
    const result = await run(code, '{}', { memoryLimitMb: 32, timeoutMs: 3000 });
    expect(result.ok).toBe(false);
  });

  it('keeps working after a run aborts its process', async () => {
    const crashed = await run('function adapt() { const m = new Map(); for (let i = 0; ; i++) m.set(i, i); }', '{}', {
      memoryLimitMb: 32,
    });
    expectFailure(crashed, 'memory_limit');
    expect(await run('function adapt() { return 1; }')).toEqual({ ok: true, output: 1 });
  });

  it('runs concurrently without one run affecting another', async () => {
    const results = await Promise.all([
      run('function adapt() { while (true) {} }', '{}', { timeoutMs: 100 }),
      run('function adapt() { const m = new Map(); for (let i = 0; ; i++) m.set(i, i); }', '{}', { memoryLimitMb: 32 }),
      run('function adapt() { return "fine"; }'),
    ]);
    expect(results[0]).toMatchObject({ ok: false, kind: 'timeout' });
    expect(results[1]).toMatchObject({ ok: false, kind: 'memory_limit' });
    expect(results[2]).toEqual({ ok: true, output: 'fine' });
  });
});

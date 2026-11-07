import { describe, expect, it, vi } from 'vitest';
import { runGate, type GateFailureCode, type GateInput, type GateOptions, type GateResult } from '../src/adapters/index.js';
import type { AdapterRequest } from '../src/contracts/index.js';
import type { RegisteredColumns } from '../src/planner/registry.js';
import { runAdapter, type SandboxResult } from '../src/sandbox/index.js';

// These spawn many sandbox processes, so a loaded machine mustn't turn a slow run into a failure.
vi.setConfig({ testTimeout: 60_000 });
const SLOW_MACHINE_LIMITS = { timeoutMs: 15_000 };

const REQUEST: AdapterRequest = { method: 'POST', path: '/ingest', query: '', headers: {} };
const LOVELACE = { id: 5, email: 'ada@example.com' };

const sample = (body: unknown, eventId = 'event-1', request = REQUEST) => ({
  eventId,
  body: body === null ? null : JSON.stringify(body),
  request,
});

const USER_ADAPTER = `function adapt(payload) {
  const d = payload.data;
  return { table: 'user', rows: [{ id: String(d.id), email: d.email }] };
}`;

function gate(code: string, input: Partial<GateInput> = {}, adapter: Partial<GateInput['adapter']> = {}, options?: GateOptions) {
  return runGate(
    {
      adapter: { code, op: 'write', opaquePaths: [], ...adapter },
      samples: [sample(LOVELACE)],
      registries: new Map(),
      ...input,
    },
    { limits: SLOW_MACHINE_LIMITS, ...options },
  );
}

function codes(result: GateResult): GateFailureCode[] {
  return result.failures.map((failure) => failure.code);
}

function registry(table: string, columns: Record<string, 'string' | 'number'>): Map<string, RegisteredColumns> {
  return new Map([['store-1', new Map([[table, new Map(Object.entries(columns))]])]]);
}

describe('passing', () => {
  it('passes a correct adapter and reports its output and schema changes', async () => {
    const result = await gate(USER_ADAPTER);
    expect(result).toMatchObject({ ok: true, failures: [], replacing: null });
    expect(result.samples[0]).toMatchObject({
      eventId: 'event-1',
      output: { table: 'user', rows: [{ id: '5', email: 'ada@example.com' }] },
    });
    expect(result.samples[0]?.schemaChanges).toContainEqual({ kind: 'add_column', table: 'user', column: 'email', type: 'string' });
  });

  it('reports only the schema changes a live store is missing', async () => {
    const result = await gate(USER_ADAPTER, { registries: registry('user', { id: 'string', email: 'string' }) });
    expect(result.samples[0]?.schemaChanges).toEqual([]);
  });

  it('never passes with no samples', async () => {
    const result = await gate(USER_ADAPTER, { samples: [] });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['no_samples']);
  });
});

describe('errors and timeouts', () => {
  it.each([
    ['a throw', `function adapt() { throw new Error('boom'); }`, 'threw'],
    ['a syntax error', `function adapt( {`, 'syntax_error'],
    ['no adapt function', `const x = 1;`, 'no_adapter'],
    ['the removed Math.random', `function adapt() { return { table: 't', rows: [{ x: Math.random() }] }; }`, 'threw'],
    ['the removed clock', `function adapt() { return { table: 't', rows: [{ x: Date.now() }] }; }`, 'threw'],
    ['an argless new Date', `function adapt() { return { table: 't', rows: [{ x: new Date().toISOString() }] }; }`, 'threw'],
    ['a function in the output', `function adapt() { return { table: 't', rows: [{ x() {} }] }; }`, 'invalid_output'],
  ])('rejects %s', async (_name, code, kind) => {
    const result = await gate(code);
    expect(codes(result)).toEqual(['run_failed']);
    expect(result.failures[0]?.detail).toContain(kind);
    expect(result.failures[0]?.eventId).toBe('event-1');
  });

  it('rejects a timeout', async () => {
    const result = await gate(`function adapt() { while (true) {} }`, {}, {}, { limits: { timeoutMs: 100 } });
    expect(codes(result)).toEqual(['run_failed']);
    expect(result.failures[0]?.detail).toContain('timeout');
  });
});

describe('determinism', () => {
  /** A sandbox stand-in that returns each result in turn, since the real one has no entropy to leak. */
  function sequence(...results: SandboxResult[]): GateOptions {
    let next = 0;
    return { run: async () => results[next++]! };
  }
  const row = (rows: unknown[]) => ({ ok: true as const, output: { table: 't', rows } });

  it('rejects output that differs between runs, naming where', async () => {
    const result = await gate('', { samples: [sample({ a: 1 })] }, {}, sequence(row([{ a: 1 }]), row([{ a: 2 }])));
    expect(codes(result)).toEqual(['nondeterministic']);
    expect(result.failures[0]?.detail).toContain('$.rows.0.a');
  });

  it('tells a cleared column from a missing one', async () => {
    const result = await gate('', { samples: [sample({})] }, {}, sequence(row([{ a: undefined }]), row([{}])));
    expect(codes(result)).toEqual(['nondeterministic']);
    expect(result.failures[0]?.detail).toContain('$.rows.0.a');
  });

  it('rejects an adapter that succeeds once and then fails', async () => {
    const failing: SandboxResult = { ok: false, kind: 'timeout', detail: 'slow' };
    const result = await gate('', { samples: [sample({})] }, {}, sequence(row([]), failing));
    expect(codes(result)).toEqual(['nondeterministic']);
  });

  it('does not care about key order', async () => {
    const result = await gate('', { samples: [sample({ a: 1, b: 2 })] }, {}, sequence(row([{ a: 1, b: 2 }]), row([{ b: 2, a: 1 }])));
    expect(result.ok).toBe(true);
  });

  it('runs the adapter twice per sample', async () => {
    let runs = 0;
    const result = await gate('', { samples: [sample({}), sample({}, 'event-2')] }, {}, {
      run: async () => {
        runs += 1;
        return row([]);
      },
    });
    expect(result.ok).toBe(true);
    expect(runs).toBe(4);
  });
});

describe('valid output', () => {
  const returning = (output: string) => `function adapt() { return ${output}; }`;

  it.each([
    ['a non-object', `5`],
    ['missing rows', `{ table: 't' }`],
    ['missing table', `{ rows: [] }`],
    ['a bad table name', `{ table: 'Bad-Name', rows: [] }`],
    ['a bad column name', `{ table: 't', rows: [{ 'Bad Col': 1 }] }`],
    ['a platform column', `{ table: 't', rows: [{ _event_seq: 1 }] }`],
    ['a name that is too long', `{ table: 't', rows: [{ ${'a'.repeat(64)}: 1 }] }`],
    ['a numeric id', `{ table: 't', rows: [{ id: 5 }] }`],
    ['_deleted: false', `{ table: 't', rows: [{ _deleted: false }] }`],
    ['NaN', `{ table: 't', rows: [{ x: NaN }] }`],
    ['Infinity', `{ table: 't', rows: [{ x: Infinity }] }`],
    ['an object column', `{ table: 't', rows: [{ x: { y: 1 } }] }`],
    ['a column colliding with the injected foreign key', `{ table: 't', rows: [{ children: { c: { rows: [{ t_id: 'x' }] } } }] }`],
  ])('rejects %s', async (_name, output) => {
    const result = await gate(returning(output), { samples: [sample({})] });
    expect(codes(result)).toEqual(['invalid_output']);
  });

  it.each([
    ['text', `'not a date'`],
    ['a missing timezone', `'2026-01-01T12:00:00'`],
    ['an impossible date', `'2026-02-30T12:00:00Z'`],
    ['a number', `1767268800`],
  ])('rejects %s in a timestamp column', async (_name, value) => {
    const output = `{ table: 't', column_types: { at: 'timestamp' }, rows: [{ at: ${value} }] }`;
    expect(codes(await gate(returning(output), { samples: [sample({})] }))).toEqual(['invalid_output']);
  });

  it('passes a valid timestamp column', async () => {
    const output = `{ table: 't', column_types: { at: 'timestamp' }, rows: [{ at: '2026-01-01T12:00:00Z' }] }`;
    expect((await gate(returning(output), { samples: [sample({})] })).ok).toBe(true);
  });

  it('reports every failure, across samples', async () => {
    const code = `function adapt(p) { if (p.data.bad) throw new Error('no'); return { table: 't', rows: [] }; }`;
    const result = await gate(code, { samples: [sample({ bad: true }, 'e1'), sample({ bad: 0, x: 'lost' }, 'e2')] });
    expect(result.failures.map(({ code: failure, eventId }) => [failure, eventId])).toEqual([
      ['run_failed', 'e1'],
      ['dropped_field', 'e2'],
      ['dropped_field', 'e2'],
    ]);
  });
});

describe('type conflicts', () => {
  it('rejects a conflict with a registered column', async () => {
    const result = await gate(USER_ADAPTER, { registries: registry('user', { email: 'number' }) });
    expect(codes(result)).toEqual(['type_conflict']);
    expect(result.failures[0]?.detail).toContain('user.email is registered as number');
  });

  it('checks every live store', async () => {
    const registries = new Map<string, RegisteredColumns>([
      ['store-1', new Map([['user', new Map([['email', 'string']])]])],
      ['store-2', new Map([['user', new Map([['email', 'number']])]])],
    ]);
    expect(codes(await gate(USER_ADAPTER, { registries }))).toEqual(['type_conflict']);
  });

  it('rejects samples that disagree, which an empty registry would not catch', async () => {
    const code = `function adapt(p) { return { table: 't', rows: [{ v: p.data.v }] }; }`;
    const result = await gate(code, { samples: [sample({ v: 1 }, 'e1'), sample({ v: 'one' }, 'e2')] });
    expect(result.failures.map(({ code: failure, eventId }) => [failure, eventId])).toEqual([['type_conflict', 'e2']]);
  });

  it('rejects a conflict within one event', async () => {
    const code = `function adapt() { return { table: 't', rows: [{ v: 1 }, { v: 'a' }] }; }`;
    expect(codes(await gate(code, { samples: [sample({})] }))).toEqual(['type_conflict']);
  });

  it('passes a value that matches, and a null in a registered column', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email, age: null }] }; }`;
    const result = await gate(code, { registries: registry('user', { email: 'string', age: 'number' }) });
    expect(result.ok).toBe(true);
  });
});

describe('opaque paths', () => {
  const METADATA_ADAPTER = `function adapt(p) { return { table: 't', rows: [{ metadata: p.data.metadata }] }; }`;
  const body = { metadata: { k: 'v' } };

  it.each(['[]', '[][]', '', 'a..b', '.a', 'a[', 'a]'])('rejects the path %j without running anything', async (path) => {
    let runs = 0;
    const result = await gate(METADATA_ADAPTER, { samples: [sample(body)] }, { opaquePaths: [path] }, {
      run: async () => {
        runs += 1;
        return { ok: true, output: {} };
      },
    });
    expect(codes(result)).toEqual(['invalid_opaque_path']);
    expect(runs).toBe(0);
  });

  it('passes a named field', async () => {
    const result = await gate(METADATA_ADAPTER, { samples: [sample(body)] }, { opaquePaths: ['metadata'] });
    expect(result.ok).toBe(true);
  });

  it('passes a named field inside an array, and inside an array of the root', async () => {
    const code = `function adapt(p) { return { table: 't', rows: p.data.map((i) => ({ metadata: i.metadata })) }; }`;
    const result = await gate(code, { samples: [sample([body])] }, { opaquePaths: ['[].metadata'] });
    expect(result.ok).toBe(true);
  });

  it('rejects an object column when the path is not declared', async () => {
    expect(codes(await gate(METADATA_ADAPTER, { samples: [sample(body)] }))).toEqual(['invalid_output']);
  });

  it('rejects a Map whose prototype was reset, which copies out as an empty object', async () => {
    const code = `function adapt(p) {
      const m = new Map(Object.entries(p.data.metadata));
      Object.setPrototypeOf(m, Object.prototype);
      return { table: 't', rows: [{ metadata: m }] };
    }`;
    const result = await gate(code, { samples: [sample(body)] }, { opaquePaths: ['metadata'] });
    expect(codes(result)).toContain('dropped_field');
  });
});

describe('op = delete', () => {
  const DELETE_REQUEST = { ...REQUEST, method: 'DELETE' };
  const deleteGate = (code: string, body: unknown = { id: 5 }) =>
    gate(code, { samples: [sample(body, 'event-1', DELETE_REQUEST)] }, { op: 'delete' });

  it('passes _deleted and an id on every top-level row', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), _deleted: true }] }; }`;
    expect((await deleteGate(code)).ok).toBe(true);
  });

  it('passes a delete with no body, identified by the path', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: p.request.path.split('/').pop(), _deleted: true }] }; }`;
    expect((await deleteGate(code, null)).ok).toBe(true);
  });

  it('rejects a row with no _deleted', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id) }] }; }`;
    expect(codes(await deleteGate(code))).toEqual(['delete_row']);
  });

  it('rejects a row with no id', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ source_id: String(p.data.id), _deleted: true }] }; }`;
    expect(codes(await deleteGate(code))).toEqual(['delete_row']);
  });

  it('checks every row of every top-level table', async () => {
    const code = `function adapt(p) { return [
      { table: 'a', rows: [{ id: String(p.data.id), _deleted: true }] },
      { table: 'b', rows: [{ id: 'x', _deleted: true }, { id: 'y' }] },
    ]; }`;
    const result = await deleteGate(code);
    expect(codes(result)).toEqual(['delete_row']);
    expect(result.failures[0]?.detail).toContain('Row 1 of table b');
  });

  it('rejects an adapter that deletes nothing', async () => {
    expect(codes(await deleteGate(`function adapt() { return { table: 'user', rows: [] }; }`, null))).toEqual(['delete_row']);
    expect(codes(await deleteGate(`function adapt() { return []; }`, null))).toEqual(['delete_row']);
  });

  it('does not require _deleted on a child row', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), _deleted: true, children: { x: { rows: [{ v: 1 }] } } }] }; }`;
    expect((await deleteGate(code)).ok).toBe(true);
  });

  it('still requires every field in the body', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), _deleted: true }] }; }`;
    const result = await deleteGate(code, { id: 5, reason: 'duplicate' });
    expect(codes(result)).toEqual(['dropped_field']);
    expect(result.failures[0]?.detail).toContain('$.reason');
  });

  it('does not apply to a write adapter', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ source_id: String(p.data.id) }] }; }`;
    expect((await gate(code, { samples: [sample({ id: 5 })] })).ok).toBe(true);
  });
});

describe('field carry through the real sandbox', () => {
  it('rejects a dropped field', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id) }] }; }`;
    const result = await gate(code);
    expect(codes(result)).toEqual(['dropped_field']);
    expect(result.failures[0]?.detail).toContain('$.email');
    expect(result.failures[0]?.detail).toContain('ada@example.com');
  });

  it('rejects a coincidental match', async () => {
    const code = `function adapt(p) { return { table: 't', rows: [{ a: p.data.a }] }; }`;
    const result = await gate(code, { samples: [sample({ a: 'x', b: 'x' })] });
    expect(codes(result)).toEqual(['dropped_field']);
    expect(result.failures[0]?.detail).toContain('other fields account for it');
  });

  it('catches on a later sample what an earlier one could not', async () => {
    const code = `function adapt(p) { return { table: 't', rows: [{ a: p.data.a, c: p.data.b === 'x' ? 'x' : 'same' }] }; }`;
    const result = await gate(code, { samples: [sample({ a: 1, b: 'x' }, 'e1'), sample({ a: 1, b: 'y' }, 'e2')] });
    expect(result.failures.map(({ eventId }) => eventId)).toEqual(['e2']);
  });

  it('caps what it lists per sample', async () => {
    const body = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, `v${i}`]));
    const result = await gate(`function adapt() { return { table: 't', rows: [] }; }`, { samples: [sample(body)] });
    expect(result.failures).toHaveLength(21);
    expect(result.failures[20]?.detail).toContain('10 more');
  });

  it('passes a long integer the adapter received as a string', async () => {
    const code = `function adapt(p) { return { table: 't', rows: [{ id: p.data.id }] }; }`;
    const samples = [{ eventId: 'e', body: '{"id":12345678901234567890}', request: REQUEST }];
    expect((await gate(code, { samples })).ok).toBe(true);
  });
});

describe('replacing an earlier version', () => {
  const V1 = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email }] }; }`;
  const earlier = { id: 'v1', code: V1, opaquePaths: [] };

  it('passes when every earlier column is still written, and new ones are fine', async () => {
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email, email_copy: p.data.email }] }; }`;
    expect(await gate(code, { earlier })).toMatchObject({ ok: true, replacing: 'v1' });
  });

  it('rejects a column the earlier version wrote', async () => {
    // The value still reaches the output, so only this check can catch the rename.
    const code = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email_address: p.data.email }] }; }`;
    const result = await gate(code, { earlier });
    expect(codes(result)).toEqual(['dropped_column']);
    expect(result.failures[0]?.detail).toContain('user.email');
  });

  it('rejects moving a column to another table', async () => {
    const code = `function adapt(p) { return { table: 'person', rows: [{ id: String(p.data.id), email: p.data.email }] }; }`;
    expect(codes(await gate(code, { earlier }))).toEqual(['dropped_column']);
  });

  it('checks child tables', async () => {
    const child = `function adapt(p) { return { table: 'u', rows: [{ id: String(p.data.id), children: { c: { rows: [{ email: p.data.email }] } } }] }; }`;
    const flat = `function adapt(p) { return { table: 'u', rows: [{ id: String(p.data.id), email: p.data.email }] }; }`;
    const result = await gate(flat, { earlier: { id: 'v1', code: child, opaquePaths: [] } });
    expect(codes(result)).toContain('dropped_column');
  });

  it('does not count a column the earlier version only cleared', async () => {
    const clears = `function adapt(p) { return { table: 'user', rows: [{ id: String(p.data.id), email: p.data.email, old: null }] }; }`;
    expect((await gate(USER_ADAPTER, { earlier: { id: 'v1', code: clears, opaquePaths: [] } })).ok).toBe(true);
  });

  it('skips the check when the earlier version fails on the sample', async () => {
    const broken = { id: 'v1', code: `function adapt() { throw new Error('old bug'); }`, opaquePaths: [] };
    expect((await gate(USER_ADAPTER, { earlier: broken })).ok).toBe(true);
  });

  it('compares per sample, so a column written on another sample does not count', async () => {
    const v1 = `function adapt(p) { return { table: 't', rows: [{ a: p.data.a, ...(p.data.b ? { b: p.data.b } : {}) }] }; }`;
    const v2 = `function adapt(p) { return { table: 't', rows: [{ a: p.data.a, ...(p.data.b === 'x' ? { b: 'x' } : { c: p.data.b }) }] }; }`;
    const samples = [sample({ a: 1, b: 'x' }, 'e1'), sample({ a: 2, b: 'y' }, 'e2')];
    const result = await gate(v2, { samples, earlier: { id: 'v1', code: v1, opaquePaths: [] } });
    expect(result.failures.map(({ code: failure, eventId }) => [failure, eventId])).toEqual([['dropped_column', 'e2']]);
  });
});

describe('when the earlier version fails on a sample', () => {
  const NEW = 'new';
  const OLD = 'old';
  const newOutput: SandboxResult = { ok: true, output: { table: 't', rows: [{ renamed: 'x' }] } };
  const oldOutput: SandboxResult = { ok: true, output: { table: 't', rows: [{ original: 'x' }] } };

  /** The new version always works. The old one returns each of `oldResults` in turn. */
  function scripted(...oldResults: SandboxResult[]) {
    const calls = { old: 0 };
    const options: GateOptions = {
      run: async ({ code }) => {
        if (code === NEW) return newOutput;
        calls.old += 1;
        return oldResults[Math.min(calls.old - 1, oldResults.length - 1)]!;
      },
    };
    return { calls, options };
  }
  const run = (options: GateOptions) =>
    gate(NEW, { samples: [sample({ a: 'x' })], earlier: { id: 'v1', code: OLD, opaquePaths: [] } }, {}, options);

  it.each(['timeout', 'memory_limit', 'crashed'] as const)('retries after %s, and still checks columns', async (kind) => {
    const { calls, options } = scripted({ ok: false, kind, detail: 'load' }, oldOutput);
    expect(codes(await run(options))).toEqual(['dropped_column']);
    expect(calls.old).toBe(2);
  });

  it('does not retry a failure that shows it wrote nothing', async () => {
    const { calls, options } = scripted({ ok: false, kind: 'threw', detail: 'bug' });
    expect((await run(options)).ok).toBe(true);
    expect(calls.old).toBe(1);
  });

  it('skips the sample if the earlier version still cannot finish', async () => {
    const { calls, options } = scripted({ ok: false, kind: 'timeout', detail: 'slow' });
    expect((await run(options)).ok).toBe(true);
    expect(calls.old).toBe(2);
  });
});

describe('a date-time in a column not declared timestamp', () => {
  const AT = '2026-01-01T12:00:00Z';
  const body = { at: AT };
  const returning = (output: string) => `function adapt(p) { const at = p.data.at; return ${output}; }`;
  const run = (output: string, input: Partial<GateInput> = {}, data: unknown = body) =>
    gate(returning(output), { samples: [sample(data)], ...input });

  it.each([
    ['with a Z', '2026-01-01T12:00:00Z'],
    ['with an offset', '2026-01-01T12:00:00+05:30'],
    ['with an hours-only offset', '2026-01-01T12:00:00+05'],
    ['with fractions', '2026-01-01T12:00:00.123456Z'],
    ['with no seconds', '2026-01-01T12:00Z'],
    ['with no zone', '2026-01-01T12:00:00'],
  ])('rejects one %s, and says how to fix it', async (_name, at) => {
    const result = await run(`{ table: 't', rows: [{ at }] }`, {}, { at });
    expect(codes(result)).toEqual(['undeclared_timestamp']);
    expect(result.failures[0]?.detail).toContain('t.at');
    expect(result.failures[0]?.detail).toContain('column_types');
  });

  it('rejects one in a child table', async () => {
    const result = await run(`{ table: 't', rows: [{ id: 'a', children: { c: { rows: [{ at }] } } }] }`);
    expect(codes(result)).toEqual(['undeclared_timestamp']);
    expect(result.failures[0]?.detail).toContain('t_c.at');
  });

  it('rejects one in a grandchild, or a later top-level table', async () => {
    const nested = `{ table: 't', rows: [{ id: 'a', children: { c: { rows: [{ id: 'b', children: { d: { rows: [{ at }] } } }] } } }] }`;
    expect(codes(await run(nested))).toEqual(['undeclared_timestamp']);
    expect(codes(await run(`[{ table: 'a', rows: [] }, { table: 'b', rows: [{ at }] }]`))).toEqual(['undeclared_timestamp']);
  });

  it('finds one that only some rows hold', async () => {
    const output = `{ table: 't', rows: [{ v: 'text' }, { v: at }] }`;
    expect(codes(await run(output))).toEqual(['undeclared_timestamp']);
  });

  it('reports a column once, however many rows hold it', async () => {
    const output = `{ table: 't', rows: [{ at }, { at: '2026-01-02T12:00:00Z' }] }`;
    expect(codes(await run(output))).toEqual(['undeclared_timestamp']);
  });

  it('passes one declared in column_types, including on a child', async () => {
    expect((await run(`{ table: 't', column_types: { at: 'timestamp' }, rows: [{ at }] }`)).ok).toBe(true);
    const child = `{ table: 't', rows: [{ id: 'a', children: { c: { column_types: { at: 'timestamp' }, rows: [{ at }] } } }] }`;
    expect((await run(child)).ok).toBe(true);
  });

  it.each([
    ['a plain date', '2026-01-01'],
    ['a year and month', '2026-01'],
    ['a time alone', '12:00:00'],
    ['a space instead of T', '2026-01-01 12:00:00'],
    ['text that mentions one', 'due 2026-01-01T12:00:00Z'],
    ['text after one', '2026-01-01T12:00:00Z!'],
    ['ordinary text', 'hello'],
    ['a number as text', '20260101'],
  ])('leaves alone %s', async (_name, value) => {
    expect((await run(`{ table: 't', rows: [{ v: p.data.v }] }`, {}, { v: value })).ok).toBe(true);
  });

  it('allows a column already registered as string, which could never be declared', async () => {
    const result = await run(`{ table: 't', rows: [{ at }] }`, { registries: registry('t', { at: 'string' }) });
    expect(result.ok).toBe(true);
  });

  it('still rejects a new column beside a registered one', async () => {
    const result = await run(`{ table: 't', rows: [{ at }] }`, { registries: registry('t', { other: 'string' }) });
    expect(codes(result)).toEqual(['undeclared_timestamp']);
  });

  it('does not reject an injected foreign key to a parent whose id is a date-time', async () => {
    const output = `{ table: 't', rows: [{ id: at, children: { c: { rows: [{ v: 1 }] } } }] }`;
    expect((await run(output)).ok).toBe(true);
  });

  it('does not apply to a json column at an opaque path', async () => {
    const result = await gate(returning(`{ table: 't', rows: [{ metadata: p.data.metadata }] }`), {
      samples: [sample({ metadata: AT })],
    }, { opaquePaths: ['metadata'] });
    expect(result.ok).toBe(true);
  });

  it('checks the sample it happens on, and caps the quoted value', async () => {
    const output = `{ table: 't', rows: [{ v: p.data.v }] }`;
    const result = await gate(returning(output), {
      samples: [sample({ v: 'text' }, 'e1'), sample({ v: '2026-01-01T12:00:00.' + '1'.repeat(500) + 'Z' }, 'e2')],
    });
    expect(result.failures.map(({ code, eventId }) => [code, eventId])).toEqual([['undeclared_timestamp', 'e2']]);
    expect(result.failures[0]?.detail.length).toBeLessThan(300);
  });
});

describe('a number in an ID-like column', () => {
  const run = (output: string, input: Partial<GateInput> = {}, data: unknown = { v: 5 }) =>
    gate(`function adapt(p) { const v = p.data.v; return ${output}; }`, { samples: [sample(data)], ...input });

  it('rejects one ending in _id, and says to cast it', async () => {
    const result = await run(`{ table: 't', rows: [{ product_id: v }] }`);
    expect(codes(result)).toEqual(['numeric_id']);
    expect(result.failures[0]?.detail).toContain('t.product_id');
    expect(result.failures[0]?.detail).toContain('String(');
  });

  it('rejects one in a child table, a grandchild, or a later top-level table', async () => {
    const child = `{ table: 't', rows: [{ id: 'a', children: { c: { rows: [{ product_id: v }] } } }] }`;
    const grandchild = `{ table: 't', rows: [{ id: 'a', children: { c: { rows: [{ id: 'b', children: { d: { rows: [{ product_id: v }] } } }] } } }] }`;
    const later = `[{ table: 'a', rows: [] }, { table: 'b', rows: [{ product_id: v }] }]`;
    for (const output of [child, grandchild, later]) expect(codes(await run(output))).toEqual(['numeric_id']);
  });

  it('rejects a numeric id at any level, through the planner', async () => {
    const top = `{ table: 't', rows: [{ id: v }] }`;
    const child = `{ table: 't', rows: [{ id: 'a', children: { c: { rows: [{ id: v }] } } }] }`;
    for (const output of [top, child]) {
      const result = await run(output);
      expect(codes(result)).toEqual(['invalid_output']);
      expect(result.failures[0]?.detail).toContain('id must be a non-empty string');
    }
  });

  it('passes the ID cast to a string', async () => {
    expect((await run(`{ table: 't', rows: [{ id: String(v), product_id: String(v) }] }`)).ok).toBe(true);
    expect((await run(`{ table: 't', rows: [{ product_id: String(v) }] }`)).ok).toBe(true);
  });

  it('passes an injected foreign key, and a null ID', async () => {
    expect((await run(`{ table: 'order', rows: [{ id: String(v), children: { c: { rows: [{ x: 1 }] } } }] }`)).ok).toBe(true);
    expect((await run(`{ table: 't', rows: [{ a: v, product_id: null }] }`)).ok).toBe(true);
  });

  it.each(['paid', 'grid', 'id_number', 'identity', 'valid'])('leaves alone the column %s', async (column) => {
    expect((await run(`{ table: 't', rows: [{ ${column}: v }] }`)).ok).toBe(true);
  });

  it('does not apply to a json column at an opaque path', async () => {
    const result = await gate(`function adapt(p) { return { table: 't', rows: [{ meta_id: p.data.meta_id }] }; }`, {
      samples: [sample({ meta_id: 5 })],
    }, { opaquePaths: ['meta_id'] });
    expect(result.ok).toBe(true);
  });

  it('catches the sweep case: an ID that passes through and later grows past 2^53', async () => {
    const samples = [
      { eventId: 'small', body: '{"product_id":5}', request: REQUEST },
      { eventId: 'big', body: '{"product_id":12345678901234567890}', request: REQUEST },
    ];
    const passesThrough = `function adapt(p) { return { table: 't', rows: [{ product_id: p.data.product_id }] }; }`;
    expect(codes(await gate(passesThrough, { samples }))).toContain('numeric_id');
    const casts = `function adapt(p) { return { table: 't', rows: [{ product_id: String(p.data.product_id) }] }; }`;
    expect((await gate(casts, { samples })).ok).toBe(true);
  });

  it('has no way to pass on a column already registered as number', async () => {
    const registries = registry('t', { product_id: 'number' });
    expect(codes(await run(`{ table: 't', rows: [{ product_id: v }] }`, { registries }))).toEqual(['numeric_id']);
    expect(codes(await run(`{ table: 't', rows: [{ product_id: String(v) }] }`, { registries }))).toEqual(['type_conflict']);
  });
});

describe('a table name that follows the request path', () => {
  const at = (path: string, body: unknown = { id: 'x' }) => [sample(body, 'event-1', { ...REQUEST, path })];
  const SEGS = `var segs = payload.request.path.split("/").filter(function (s) { return s.length > 0; });`;

  /** The bug as generated: `segs[1]` names the table, and the fallback looks harmless. */
  const FROM_PATH = `function adapt(payload) {
    var path = payload.request.path;
    var segs = path.split("/").filter(function (s) { return s.length > 0; });
    var table = segs.length > 1 ? segs[1] : "products";
    return { table: table, rows: [{ id: String(payload.data.id) }] };
  }`;

  it('rejects the generated Shopify adapter, naming both sets of tables and the fix', async () => {
    const result = await gate(FROM_PATH, { samples: at('/ingest/shopify') });
    expect(codes(result)).toEqual(['computed_table']);
    expect(result.failures[0]).toMatchObject({ eventId: 'event-1' });
    expect(result.failures[0]?.detail).toContain('this path writes shopify,');
    expect(result.failures[0]?.detail).toContain('fixed string literal');
  });

  it.each([
    ['a child that sets table', `{ table: 'p', rows: [{ id: 'x', children: { images: { table: segs[1] + '_images', rows: [{ id: 'i' }] } } }] }`],
    ['a grandchild that sets table', `{ table: 'p', rows: [{ id: 'x', children: { a: { rows: [{ id: 'a', children: { b: { table: segs[1], rows: [{ id: 'b' }] } } }] } } }] }`],
    ['a child key, which names the default table', `{ table: 'p', rows: [{ id: 'x', children: { [segs[1]]: { rows: [{ id: 'i' }] } } }] }`],
    ['a later top-level table', `[{ table: 'p', rows: [{ id: 'x' }] }, { table: segs[1] + '_log', rows: [{ id: 'l' }] }]`],
    ['a child with no rows on this sample, which the planner would skip', `{ table: 'p', rows: [{ id: 'x', children: { images: { table: segs[1] + '_images', rows: [] } } }] }`],
    ['a top-level table with no rows on this sample', `[{ table: 'p', rows: [{ id: 'x' }] }, { table: segs[1], rows: [] }]`],
    ['a later segment', `{ table: segs[2], rows: [{ id: 'x' }] }`],
    ['a name reshaped from the path', `{ table: segs[1].slice(0, 3) + 's', rows: [{ id: 'x' }] }`],
    ['a literal for this path, and the path otherwise', `{ table: segs[1] === 'shopify' ? 'products' : segs[1], rows: [{ id: 'x' }] }`],
  ])('rejects %s', async (_name, output) => {
    const code = `function adapt(payload) { ${SEGS} return ${output}; }`;
    expect(codes(await gate(code, { samples: at('/ingest/shopify/products') }))).toContain('computed_table');
  });

  it('quotes only the tables that move, so a long list of fixed ones cannot hide them', async () => {
    const fixed = ['a_1', 'a_2', 'a_3', 'a_4', 'a_5', 'a_6'].map((table) => `{ table: '${table}', rows: [{ id: 'x' }] }`).join(', ');
    const code = `function adapt(payload) { ${SEGS} return [${fixed}, { table: 'z_' + segs[1], rows: [{ id: 'x' }] }]; }`;
    const detail = (await gate(code, { samples: at('/ingest/shopify') })).failures[0]?.detail ?? '';
    expect(detail).toContain('this path writes z_shopify, and a different one writes z_');
    expect(detail).not.toContain('a_1');
  });

  it('leaves percent escapes intact, so an adapter that decodes the path still runs', async () => {
    // Shifted, `%C3%A9` would be invalid UTF-8, the decode would throw, and the check would learn nothing.
    const code = `function adapt(payload) { ${SEGS} return { table: decodeURIComponent(segs[1]).slice(0, 3), rows: [{ id: 'x' }] }; }`;
    expect(codes(await gate(code, { samples: at('/ingest/caf%C3%A9') }))).toEqual(['computed_table']);
  });

  it('reports it beside other failures, so one retry can fix them all', async () => {
    const code = `function adapt(payload) { ${SEGS} return { table: segs[1], rows: [{ other: 'y' }] }; }`;
    expect(codes(await gate(code, { samples: at('/ingest/shopify') }))).toEqual(expect.arrayContaining(['computed_table', 'dropped_field']));
  });

  it('checks every sample', async () => {
    const code = `function adapt(payload) { ${SEGS} return { table: segs.length > 2 ? segs[2] : 'p', rows: [{ id: 'x' }] }; }`;
    const samples = [...at('/ingest/a'), sample({ id: 'x' }, 'event-2', { ...REQUEST, path: '/ingest/a/b' })];
    const result = await gate(code, { samples });
    expect(result.failures.map(({ code: failure, eventId }) => [failure, eventId])).toEqual([['computed_table', 'event-2']]);
  });

  it.each([
    ['a table named like its path', '/ingest/sponsors', `{ table: 'sponsors', rows: [{ id: 'x' }] }`],
    ['a literal on a bare path', '/ingest', `{ table: 'products', rows: [{ id: 'x' }] }`],
    ['literals in nested tables', '/ingest/shopify', `[{ table: 'products', rows: [{ id: 'x', children: { images: { rows: [{ id: 'i' }] }, tags: { table: 'product_tags', rows: [] } } }] }]`],
    ['a path used to choose a column', '/ingest/shopify/archive', `{ table: 'products', rows: [{ id: 'x', archived: segs[2] === 'archive' }] }`],
    ['a segment copied into a column', '/ingest/shopify', `{ table: 'products', rows: [{ id: 'x', via: segs[1] }] }`],
    ['a literal chosen by the path, landing on its fallback', '/ingest/hub/sponsors', `{ table: segs[2] === 'sponsors' ? 'sponsors' : 'speakers', rows: [{ id: 'x' }] }`],
    ['an unknown path that yields no table', '/ingest/hub/sponsors', `{ table: ({ sponsors: 'sponsors' })[segs[2]], rows: [{ id: 'x' }] }`],
  ])('passes %s', async (_name, path, output) => {
    const code = `function adapt(payload) { ${SEGS} return ${output}; }`;
    expect(await gate(code, { samples: at(path) })).toMatchObject({ ok: true, failures: [] });
  });

  it.each([
    ['a number', '/ingest/speakers/123', /^\d+$/.source],
    ['a UUID', '/ingest/speakers/6f2a0d10-1111-4b7a-8c01-aa0000000001', /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.source],
    ['a prefixed id', '/ingest/speakers/spk_12', /^[a-z]+_\d+$/.source],
  ])('passes an adapter that requires %s in the path, and throws otherwise', async (_name, path, format) => {
    const code = `function adapt(payload) {
      ${SEGS}
      if (segs.length !== 3 || !new RegExp(${JSON.stringify(format)}).test(segs[2])) throw new Error('no id in the path');
      return { table: 'speakers', rows: [{ id: segs[2] }] };
    }`;
    const samples = [sample(null, 'event-1', { ...REQUEST, method: 'DELETE', path })];
    const runs: { path: string; ok: boolean }[] = [];
    const result = await gate(code, { samples }, {}, {
      run: async (input) => {
        const outcome = await runAdapter(input, SLOW_MACHINE_LIMITS);
        runs.push({ path: input.request.path, ok: outcome.ok });
        return outcome;
      },
    });
    expect(result).toMatchObject({ ok: true, failures: [] });
    // Passing because the altered run threw would prove nothing about the path it was given.
    expect(runs).toHaveLength(3);
    const altered = runs.find((run) => run.path !== path)!;
    expect(altered.ok).toBe(true);
    expect(altered.path.split('/')).toHaveLength(path.split('/').length);
    expect(altered.path).toMatch(/^\/ingest\/[a-z]/);
  });

  it('passes an adapter that throws only on the altered path, since that says nothing about its names', async () => {
    const code = `function adapt(payload) {
      ${SEGS}
      if (segs[1] !== 'speakers') throw new Error('wrong source');
      return { table: 'speakers', rows: [{ id: 'x' }] };
    }`;
    expect(await gate(code, { samples: at('/ingest/speakers') })).toMatchObject({ ok: true, failures: [] });
  });

  it('passes when the second altered path fails, with nothing to confirm the change', async () => {
    let runs = 0;
    const result = await gate('', { samples: at('/ingest/a', {}) }, {}, {
      run: async () => {
        runs += 1;
        if (runs === 3) return { ok: true, output: { table: 'other', rows: [] } };
        if (runs === 4) return { ok: false, kind: 'threw', detail: 'boom' };
        return { ok: true, output: { table: 't', rows: [] } };
      },
    });
    expect(result.ok).toBe(true);
    expect(runs).toBe(4);
  });

  it('never runs an altered path on a bare /ingest, where there is nothing to change', async () => {
    const paths: string[] = [];
    await gate('', { samples: at('/ingest', {}) }, {}, {
      run: async ({ request }) => {
        paths.push(request.path);
        return { ok: true, output: { table: 't', rows: [] } };
      },
    });
    expect(paths).toEqual(['/ingest', '/ingest']);
  });

  it('keeps the rest of the request, and alters only the path', async () => {
    const request = { method: 'PATCH', path: '/ingest/a', query: 'x=1', headers: { 'x-shopify-topic': 'orders/paid' } };
    const seen: AdapterRequest[] = [];
    await gate('', { samples: [sample({}, 'event-1', request)] }, {}, {
      run: async ({ request: received }) => {
        seen.push(received);
        return { ok: true, output: { table: 't', rows: [] } };
      },
    });
    expect(seen[2]).toEqual({ ...request, path: expect.not.stringMatching(/^\/ingest\/a$/) });
  });

  it('does not count a table the planner would have rejected as a computed name', async () => {
    const code = `function adapt(payload) { return { table: 'Not Valid', rows: [{ id: 'x' }] }; }`;
    expect(codes(await gate(code, { samples: at('/ingest/a') }))).toEqual(['invalid_output']);
  });
});

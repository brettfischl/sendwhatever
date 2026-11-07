import { describe, expect, it } from 'vitest';
import { runGate, type GateFailureCode, type GateInput, type GateOptions, type GateResult } from '../src/adapters/index.js';
import type { AdapterRequest } from '../src/contracts/index.js';
import type { RegisteredColumns } from '../src/planner/registry.js';
import type { SandboxResult } from '../src/sandbox/index.js';

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
    options,
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
    const code = `function adapt(p) { return { table: 'user', rows: [{ source_id: p.data.id, _deleted: true }] }; }`;
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
    const code = `function adapt(p) { return { table: 'user', rows: [{ source_id: p.data.id }] }; }`;
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

import { describe, expect, it } from 'vitest';
import { findDroppedValues, parseBodyLikeSandbox } from '../src/adapters/index.js';
import type { AdapterResult } from '../src/contracts/index.js';
import { planWrite } from '../src/planner/index.js';

/** What was dropped when `output` is the adapter's result for `data`, as `path` strings. */
function dropped(data: unknown, output: unknown, opaquePaths: string[] = []): string[] {
  const result = planWrite(output as AdapterResult, {
    eventId: 'e',
    eventSeq: '1',
    receivedAt: '2026-11-07T12:00:00.000Z',
    opaquePaths,
  });
  if (!result.ok) throw new Error(result.detail);
  return findDroppedValues(data, result.plan.tables, opaquePaths).map((item) => item.path);
}

const table = (...rows: unknown[]) => ({ table: 't', rows });

describe('a dropped field', () => {
  it('passes when every value is carried, under any column name', () => {
    expect(dropped({ first: 'Ada', age: 36 }, table({ first_name: 'Ada', age_years: 36 }))).toEqual([]);
  });

  it('is reported with its path', () => {
    expect(dropped({ a: 'x', b: 'y' }, table({ a: 'x' }))).toEqual(['$.b']);
  });

  it('is reported at any depth, inside arrays', () => {
    const data = { orders: [{ sku: 'A1', meta: { note: 'n' } }] };
    expect(dropped(data, table({ sku: 'A1' }))).toEqual(['$.orders[].meta.note']);
  });

  it('is reported when only some rows lose it', () => {
    const data = [{ sku: 'A', amount: 100 }, { sku: 'B', amount: 100 }];
    expect(dropped(data, table({ sku: 'A', amount: 100 }, { sku: 'B' }))).toEqual(['$[].amount']);
  });

  it('is reported when a list is cut short', () => {
    const data = { items: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }] };
    expect(dropped(data, table({ sku: 'A' }))).toEqual(['$.items[].sku', '$.items[].sku']);
  });

  it('counts empty strings, zero and false as values', () => {
    expect(dropped({ a: '', b: 0, c: false, d: 'kept' }, table({ d: 'kept' }))).toEqual(['$.a', '$.b', '$.c']);
  });

  it('does not count an output row with no values as carrying anything', () => {
    expect(dropped({ a: 'x' }, table())).toEqual(['$.a']);
  });
});

describe('a value that appears only by coincidence', () => {
  it('does not carry another field with an equal string', () => {
    expect(dropped({ a: 'x', b: 'x' }, table({ a: 'x' }))).toHaveLength(1);
  });

  it('does not carry another field with an equal number', () => {
    expect(dropped({ count: 5, qty: 5 }, table({ count: 5 }))).toHaveLength(1);
  });

  it('does not carry another field through a cast', () => {
    expect(dropped({ code: '5', n: 5 }, table({ code: '5' }))).toHaveLength(1);
  });

  it('does not carry another field with an equal boolean', () => {
    expect(dropped({ active: true, verified: true }, table({ active: true }))).toHaveLength(1);
  });

  it('does not let a parent id carry a child field', () => {
    const data = { id: '1', items: [{ sku: '1' }] };
    expect(dropped(data, table({ id: '1' }))).toHaveLength(1);
  });

  it('does not count a table or column name as a value', () => {
    expect(dropped({ kind: 'user' }, { table: 'user', rows: [{ user: null }] })).toEqual(['$.kind']);
  });

  it('passes when each equal value has its own column', () => {
    expect(dropped({ a: 'x', b: 'x' }, table({ a: 'x', b: 'x' }))).toEqual([]);
  });

  it('says that the value is there but already accounted for', () => {
    const result = planWrite(table({ a: 'x' }) as AdapterResult, {
      eventId: 'e', eventSeq: '1', receivedAt: '2026-11-07T12:00:00.000Z', opaquePaths: [],
    });
    if (!result.ok) throw new Error(result.detail);
    expect(findDroppedValues({ a: 'x', b: 'x' }, result.plan.tables, [])[0]).toMatchObject({ claimedElsewhere: true });
    expect(findDroppedValues({ a: 'y' }, result.plan.tables, [])[0]).toMatchObject({ claimedElsewhere: false });
  });
});

describe('merged fields', () => {
  it('fails when a merged value replaces its originals', () => {
    const data = { first: 'Ada', last: 'Lovelace' };
    expect(dropped(data, table({ full_name: 'Ada Lovelace' }))).toEqual(['$.first', '$.last']);
  });

  it('passes when a merged value keeps its originals', () => {
    const data = { first: 'Ada', last: 'Lovelace' };
    expect(dropped(data, table({ first: 'Ada', last: 'Lovelace', full_name: 'Ada Lovelace' }))).toEqual([]);
  });

  it('fails when a prefixed id replaces the original', () => {
    expect(dropped({ id: 5 }, table({ id: 'usr_5' }))).toEqual(['$.id']);
  });

  it('passes when a prefixed id keeps the original in a column', () => {
    expect(dropped({ id: 5 }, table({ id: 'usr_5', source_id: 5 }))).toEqual([]);
  });

  it('fails when a sum replaces its parts', () => {
    expect(dropped({ net: 7, tax: 3 }, table({ total: 10 }))).toEqual(['$.net', '$.tax']);
  });
});

describe('casts', () => {
  it.each([
    ['number to string', 5, '5'],
    ['string to number', '5', 5],
    ['boolean to string', true, 'true'],
    ['string to boolean', 'false', false],
    ['float to string', 19.9, '19.9'],
    ['decimal text to number, dropping trailing zeros', '19.90', 19.9],
    ['number to decimal text', 19.9, '19.90'],
    ['whole decimal text to number', '5.0', 5],
    ['negative number to string', -3, '-3'],
  ])('allows %s', (_name, value, output) => {
    expect(dropped({ a: value }, table({ a: output }))).toEqual([]);
  });

  it.each([
    ['leading zeros lost', '007', 7],
    ['a zip code losing its zero', '01234', 1234],
    ['case changed', 'Ada@Example.com', 'ada@example.com'],
    ['whitespace trimmed', ' x ', 'x'],
    ['one to true', 1, true],
    ['yes to true', 'yes', true],
    ['rounding', 19.9, 20],
    ['precision lost from a long number', '12345678901234567890', Number('12345678901234567890')],
  ])('rejects %s', (_name, value, output) => {
    expect(dropped({ a: value }, table({ a: output }))).toEqual(['$.a']);
  });

  it('allows a cast id', () => {
    expect(dropped({ id: 5 }, table({ id: '5' }))).toEqual([]);
  });

  it('matches a long integer the way the sandbox delivers it', () => {
    const data = parseBodyLikeSandbox('{"id":12345678901234567890}');
    expect(data).toEqual({ id: '12345678901234567890' });
    expect(dropped(data, table({ id: '12345678901234567890' }))).toEqual([]);
  });

  it('keeps ordinary numbers as numbers when parsing like the sandbox', () => {
    expect(parseBodyLikeSandbox('{"a":1.5,"b":2,"c":"3"}')).toEqual({ a: 1.5, b: 2, c: '3' });
    expect(parseBodyLikeSandbox('')).toBeNull();
    expect(parseBodyLikeSandbox(null)).toBeNull();
  });
});

describe('normalized timestamps', () => {
  const declared = (value: string) => ({
    table: 't',
    column_types: { at: 'timestamp' },
    rows: [{ at: value }],
  });

  it.each([
    ['another offset', '2026-01-01T12:00:00+00:00', '2026-01-01T12:00:00Z'],
    ['a shifted zone', '2026-01-01T12:00:00+05:30', '2026-01-01T06:30:00Z'],
    ['no zone, read as UTC', '2026-01-01T12:00:00', '2026-01-01T12:00:00Z'],
    ['a space instead of T', '2026-01-01 12:00:00', '2026-01-01T12:00:00Z'],
    ['a date only', '2026-01-01', '2026-01-01T00:00:00Z'],
    ['a US date', '01/02/2026', '2026-01-02T00:00:00Z'],
    ['an HTTP date', 'Thu, 01 Jan 2026 12:00:00 GMT', '2026-01-01T12:00:00Z'],
    ['an hours-only output offset', '2026-01-01T12:00:00Z', '2026-01-01T17:00:00+05'],
  ])('allows %s', (_name, value, output) => {
    expect(dropped({ when: value }, declared(output))).toEqual([]);
  });

  it('allows epoch seconds and milliseconds, as numbers or text', () => {
    const output = declared('2026-01-01T12:00:00Z');
    expect(dropped({ when: 1767268800 }, output)).toEqual([]);
    expect(dropped({ when: 1767268800000 }, output)).toEqual([]);
    expect(dropped({ when: '1767268800' }, output)).toEqual([]);
  });

  it('rejects a different instant', () => {
    expect(dropped({ when: '2026-01-01T12:00:00Z' }, declared('2026-01-01T13:00:00Z'))).toEqual(['$.when']);
  });

  it('rejects precision lost in normalizing', () => {
    expect(dropped({ when: '2026-01-01T12:00:00.123Z' }, declared('2026-01-01T12:00:00Z'))).toEqual(['$.when']);
  });

  it('does not treat a column that is not declared timestamp as a normalized date', () => {
    expect(dropped({ when: '2026-01-01' }, table({ when: '2026-01-01T00:00:00Z' }))).toEqual(['$.when']);
  });

  it('does not let one timestamp column carry two fields', () => {
    const data = { created: '2026-01-01T12:00:00+00:00', updated: '2026-01-01T12:00:00+00:00' };
    expect(dropped(data, declared('2026-01-01T12:00:00Z'))).toHaveLength(1);
  });
});

describe('delete flags', () => {
  it.each(['deleted', 'is_deleted', 'isDeleted', '_deleted', 'removed', 'destroyed'])(
    'allows %s: true becoming _deleted',
    (key) => {
      expect(dropped({ id: '1', [key]: true }, table({ id: '1', _deleted: true }))).toEqual([]);
    },
  );

  it('needs _deleted or a column for a true flag', () => {
    expect(dropped({ id: '1', deleted: true }, table({ id: '1' }))).toEqual(['$.deleted']);
  });

  it('allows the flag kept as a column', () => {
    expect(dropped({ id: '1', deleted: true }, table({ id: '1', was_deleted: true }))).toEqual([]);
  });

  it('allows deleted: false to leave no trace', () => {
    expect(dropped({ id: '1', deleted: false }, table({ id: '1' }))).toEqual([]);
  });

  it('does not treat other true fields as delete flags', () => {
    expect(dropped({ id: '1', active: true }, table({ id: '1', _deleted: true }))).toEqual(['$.active']);
  });

  it('does not treat non-boolean delete fields as flags', () => {
    expect(dropped({ id: '1', deleted_at: '2026-01-01' }, table({ id: '1', _deleted: true }))).toEqual(['$.deleted_at']);
    expect(dropped({ id: '1', status: 'deleted' }, table({ id: '1', _deleted: true }))).toEqual(['$.status']);
  });

  it('needs one deleted row per flag', () => {
    const data = { items: [{ id: 'a', deleted: true }, { id: 'b', deleted: true }] };
    expect(dropped(data, table({ id: 'a', _deleted: true }, { id: 'b' }))).toEqual(['$.items[].deleted']);
    expect(dropped(data, table({ id: 'a', _deleted: true }, { id: 'b', _deleted: true }))).toEqual([]);
  });

  it('lets the flag take _deleted when another true field needs the column', () => {
    const data = { id: '1', deleted: true, active: true };
    expect(dropped(data, table({ id: '1', _deleted: true, active: true }))).toEqual([]);
  });

  it('counts a deleted child row', () => {
    const data = { id: 'o', items: [{ id: 'i', deleted: true }] };
    const output = table({ id: 'o', children: { items: { rows: [{ id: 'i', _deleted: true }] } } });
    expect(dropped(data, output)).toEqual([]);
  });
});

describe('structure', () => {
  it('finds values in child tables at any depth', () => {
    const data = { id: 'u', orders: [{ sku: 'A', lines: [{ qty: 2 }] }] };
    const output = table({
      id: 'u',
      children: { orders: { rows: [{ sku: 'A', children: { lines: { rows: [{ qty: 2 }] } } }] } },
    });
    expect(dropped(data, output)).toEqual([]);
  });

  it('finds values across several top-level tables', () => {
    const data = { id: 'o', customer: { id: 'c', name: 'Ada' } };
    const output = [table({ id: 'o', customer_id: 'c' }), { table: 'customer', rows: [{ id: 'c', name: 'Ada' }] }];
    expect(dropped(data, output)).toEqual([]);
  });

  it('lets an injected foreign key carry a redundant child field', () => {
    const data = { id: 'o', items: [{ t_ref: 'o', sku: 'A' }] };
    const output = table({ id: 'o', children: { items: { rows: [{ sku: 'A' }] } } });
    expect(dropped(data, output)).toEqual([]);
  });

  it('ignores null fields, and does not need them carried', () => {
    expect(dropped({ a: null, b: [null], c: 'x' }, table({ c: 'x' }))).toEqual([]);
  });

  it('needs nothing for an empty body, object or array', () => {
    expect(dropped(null, table())).toEqual([]);
    expect(dropped({}, table())).toEqual([]);
    expect(dropped({ a: {}, b: [] }, table())).toEqual([]);
  });

  it('allows a primitive array as a child table with a value column', () => {
    const data = { id: 'u', tags: ['a', 'b'] };
    const output = table({ id: 'u', children: { tags: { rows: [{ value: 'a' }, { value: 'b' }] } } });
    expect(dropped(data, output)).toEqual([]);
  });
});

describe('repeated data', () => {
  it('passes an entity embedded in several parents, merged into one row (§8)', () => {
    const customer = { id: 'c1', name: 'Ada' };
    const data = { orders: [{ sku: 'A', customer }, { sku: 'B', customer }] };
    const output = [
      table({ sku: 'A', customer_id: 'c1' }, { sku: 'B', customer_id: 'c1' }),
      { table: 'customer', rows: [{ id: 'c1', name: 'Ada' }, { id: 'c1', name: 'Ada' }] },
    ];
    expect(dropped(data, output)).toEqual([]);
  });

  it('passes duplicate primitives collapsed to one row', () => {
    const output = table({ children: { tags: { rows: [{ value: 'a' }] } } });
    expect(dropped({ tags: ['a', 'a'] }, output)).toEqual([]);
  });

  it('passes an identical repeat in any key order', () => {
    const data = [{ c: { a: 1, b: 2 } }, { c: { b: 2, a: 1 } }];
    expect(dropped(data, table({ a: 1, b: 2 }))).toEqual([]);
  });

  it('does not collapse equal values on different items', () => {
    const data = { items: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 1 }] };
    const output = table({ sku: 'A', qty: 1 }, { sku: 'B' });
    expect(dropped(data, output)).toEqual(['$.items[].qty']);
  });

  it('does not collapse an equal object at different paths', () => {
    const data = { billing: { city: 'Paris' }, shipping: { city: 'Paris' } };
    expect(dropped(data, table({ city: 'Paris' }))).toHaveLength(1);
  });

  it('fails when one constant id merges away the other rows', () => {
    const data = { items: [{ sku: 'A' }, { sku: 'B' }] };
    const output = table({ id: 'x', sku: 'A' }, { id: 'x', sku: 'B' });
    expect(dropped(data, output)).toEqual(['$.items[].sku']);
  });
});

describe('opaque paths', () => {
  it('passes a json column that holds the whole value', () => {
    const data = { id: '1', metadata: { plan: 'pro', seats: 3, nested: { x: true } } };
    expect(dropped(data, table({ id: '1', metadata: data.metadata }), ['metadata'])).toEqual([]);
  });

  it('fails when a key is removed from the json column', () => {
    const data = { metadata: { plan: 'pro', seats: 3 } };
    expect(dropped(data, table({ metadata: { plan: 'pro' } }), ['metadata'])).toEqual(['$.metadata key', '$.metadata.seats']);
  });

  it('fails when a value is emptied, as a Map or Date copied out of the sandbox would be', () => {
    const data = { metadata: { plan: 'pro' } };
    expect(dropped(data, table({ metadata: {} }), ['metadata'])).toEqual(['$.metadata key', '$.metadata.plan']);
  });

  it('passes a key and value child table', () => {
    const data = { metadata: { plan: 'pro', tier: 'gold' } };
    const output = table({
      children: { metadata: { rows: [{ key: 'plan', value: 'pro' }, { key: 'tier', value: 'gold' }] } },
    });
    expect(dropped(data, output, ['metadata'])).toEqual([]);
  });

  it('fails when a varying key is lost, since the key is the data', () => {
    const data = { scores: { u123: 5 } };
    const output = table({ children: { scores: { rows: [{ value: 5 }] } } });
    expect(dropped(data, output, ['scores'])).toEqual(['$.scores key']);
  });

  it('applies to an opaque path inside an array', () => {
    const data = { orders: [{ metadata: { k: 'v' } }] };
    expect(dropped(data, table({ metadata: { k: 'v' } }), ['orders[].metadata'])).toEqual([]);
    expect(dropped(data, table({ other: 'v' }))).toEqual([]);
    expect(dropped(data, table({ other: 'v' }), ['orders[].metadata'])).toEqual(['$.orders[].metadata key']);
  });

  it('keeps ordinary keys out of it outside the opaque path', () => {
    expect(dropped({ plan: 'pro' }, table({ tier: 'pro' }), ['metadata'])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AdapterResult, SchemaChange, TableRow, TableRows } from '../src/contracts/index.js';
import { planWrite, type PlanContext, type WritePlan } from '../src/planner/index.js';
import { uuid5 } from '../src/planner/uuid5.js';

const CONTEXT: PlanContext = {
  eventId: '0190a5f0-0000-7000-8000-000000000001',
  // Above 2^53, so a conversion to number would change it.
  eventSeq: '9007199254740993',
  receivedAt: '2026-11-07T12:00:00.000Z',
  opaquePaths: [],
};

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The output is untrusted at runtime, so many tests pass what the types would reject. */
function plan(output: unknown, context: Partial<PlanContext> = {}): WritePlan {
  const result = planWrite(output as AdapterResult, { ...CONTEXT, ...context });
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result.plan;
}

function failure(output: unknown, context: Partial<PlanContext> = {}) {
  const result = planWrite(output as AdapterResult, { ...CONTEXT, ...context });
  if (result.ok) throw new Error('Expected the plan to fail');
  return result;
}

function tableOf(result: WritePlan, name: string): TableRows {
  const table = result.tables.find((candidate) => candidate.table === name);
  if (!table) throw new Error(`No table ${name}`);
  return table;
}

function rowsOf(result: WritePlan, name: string): TableRow[] {
  return tableOf(result, name).rows;
}

function onlyRow(result: WritePlan, name: string): TableRow {
  const rows = rowsOf(result, name);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const one = (row: unknown) => ({ table: 't', rows: [row] });

const SECTION_8_EXAMPLE = {
  table: 'user',
  rows: [
    {
      id: 'usr_01J',
      email: 'ada@example.com',
      children: {
        profile: {
          table: 'user_profile',
          rows: [{ first_name: 'Ada', last_name: 'Lovelace' }],
        },
        orders: {
          table: 'user_orders',
          rows: [
            { sku: 'A1', amount: 100 },
            { sku: 'A2', amount: 200 },
          ],
        },
      },
    },
  ],
};

describe('uuid5', () => {
  it('produces a valid, deterministic version 5 UUID', () => {
    expect(uuid5('a')).toMatch(UUID_V5);
    expect(uuid5('a')).toBe(uuid5('a'));
    expect(uuid5('a')).not.toBe(uuid5('b'));
  });
});

describe('the §8 example', () => {
  const result = plan(SECTION_8_EXAMPLE);

  it('writes the parent row, without a foreign key', () => {
    expect(rowsOf(result, 'user')).toEqual([
      { id: 'usr_01J', _event_seq: CONTEXT.eventSeq, email: 'ada@example.com' },
    ]);
  });

  it('writes the child rows with injected id and user_id', () => {
    const profile = onlyRow(result, 'user_profile');
    expect(profile).toEqual({
      id: expect.stringMatching(UUID_V5),
      _event_seq: CONTEXT.eventSeq,
      user_id: 'usr_01J',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    expect(rowsOf(result, 'user_orders')).toEqual([
      {
        id: expect.stringMatching(UUID_V5),
        _event_seq: CONTEXT.eventSeq,
        user_id: 'usr_01J',
        sku: 'A1',
        amount: 100,
      },
      {
        id: expect.stringMatching(UUID_V5),
        _event_seq: CONTEXT.eventSeq,
        user_id: 'usr_01J',
        sku: 'A2',
        amount: 200,
      },
    ]);
  });

  it('lists the columns, excluding platform columns but including the foreign key', () => {
    expect(tableOf(result, 'user').columns).toEqual({ email: 'string' });
    expect(tableOf(result, 'user_orders').columns).toEqual({
      user_id: 'string',
      sku: 'string',
      amount: 'number',
    });
  });

  it('creates the tables and columns, and indexes each foreign key', () => {
    const expected: SchemaChange[] = [
      { kind: 'create_table', table: 'user' },
      { kind: 'add_column', table: 'user', column: 'email', type: 'string' },
      { kind: 'create_table', table: 'user_profile' },
      { kind: 'add_column', table: 'user_profile', column: 'user_id', type: 'string' },
      { kind: 'add_index', table: 'user_profile', column: 'user_id' },
      { kind: 'add_column', table: 'user_profile', column: 'first_name', type: 'string' },
      { kind: 'add_column', table: 'user_profile', column: 'last_name', type: 'string' },
      { kind: 'create_table', table: 'user_orders' },
      { kind: 'add_column', table: 'user_orders', column: 'user_id', type: 'string' },
      { kind: 'add_index', table: 'user_orders', column: 'user_id' },
      { kind: 'add_column', table: 'user_orders', column: 'sku', type: 'string' },
      { kind: 'add_column', table: 'user_orders', column: 'amount', type: 'number' },
    ];
    expect(result.changes).toEqual(expected);
  });
});

describe('deterministic IDs', () => {
  it('produces an identical plan when an event is reprocessed', () => {
    const output = [
      { table: 'a', rows: [{ x: 1, children: { b: { rows: [{ y: 2 }] } } }] },
      SECTION_8_EXAMPLE,
    ];
    expect(plan(output)).toEqual(plan(structuredClone(output)));
  });

  it('keeps a child of a supplied id stable across events, so a repeat updates it', () => {
    const later = plan(SECTION_8_EXAMPLE, { eventId: 'other-event', eventSeq: '5' });
    expect(rowsOf(later, 'user_orders').map((row) => row.id)).toEqual(
      rowsOf(plan(SECTION_8_EXAMPLE), 'user_orders').map((row) => row.id),
    );
  });

  it('gives each position its own child id, and uses a supplied child id as is', () => {
    const rows = rowsOf(
      plan({
        table: 'p',
        rows: [{ id: '1', children: { c: { rows: [{ x: 1 }, { id: 'mine' }, { x: 3 }] } } }],
      }),
      'p_c',
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows[1]!.id).toBe('mine');
  });

  it('derives append children from the event, so each event adds rows', () => {
    const output = {
      table: 'chat',
      rows: [{ id: 'c1', children: { messages: { append: true, rows: [{ text: 'hi' }] } } }],
    };
    const first = onlyRow(plan(output), 'chat_messages');
    const repeat = onlyRow(plan(output), 'chat_messages');
    const next = onlyRow(plan(output, { eventId: 'other-event' }), 'chat_messages');
    expect(first.id).toBe(repeat.id);
    expect(first.id).not.toBe(next.id);
  });

  it('derives top-level rows and children of an id-less parent from the event', () => {
    const output = { table: 'p', rows: [{ x: 1, children: { c: { rows: [{ y: 1 }] } } }] };
    const first = plan(output);
    const next = plan(output, { eventId: 'other-event' });
    expect(onlyRow(first, 'p').id).not.toBe(onlyRow(next, 'p').id);
    expect(onlyRow(first, 'p_c').id).not.toBe(onlyRow(next, 'p_c').id);
    expect(onlyRow(first, 'p_c').p_id).toBe(onlyRow(first, 'p').id);
  });

  it('treats a child of a position-derived parent as event-derived, per the §8 wording', () => {
    const output = {
      table: 'a',
      rows: [{ id: '1', children: { b: { rows: [{ children: { c: { rows: [{ x: 1 }] } } }] } } }],
    };
    const first = plan(output);
    const next = plan(output, { eventId: 'other-event' });
    expect(onlyRow(first, 'a_b').id).toBe(onlyRow(next, 'a_b').id);
    expect(onlyRow(first, 'a_b_c').id).not.toBe(onlyRow(next, 'a_b_c').id);
    expect(onlyRow(first, 'a_b_c').a_b_id).toBe(onlyRow(next, 'a_b_c').a_b_id);
  });

  it('keeps rows at different paths apart when they share a table', () => {
    const result = plan([
      { table: 't', rows: [{ x: 1 }, { x: 2 }] },
      { table: 't', rows: [{ x: 3 }] },
    ]);
    expect(new Set(rowsOf(result, 't').map((row) => row.id)).size).toBe(3);
  });

  it('keeps children apart when two keys under one parent name the same table', () => {
    const rows = rowsOf(
      plan({
        table: 'p',
        rows: [
          {
            id: '1',
            children: {
              home: { table: 'address', rows: [{ city: 'A' }] },
              work: { table: 'address', rows: [{ city: 'B' }] },
            },
          },
        ],
      }),
      'address',
    );
    expect(rows.map((row) => row.city)).toEqual(['A', 'B']);
  });

  it("doesn't shift a child's id when an earlier list naming the same table grows", () => {
    const output = (homes: unknown[]) => ({
      table: 'p',
      rows: [
        {
          id: '1',
          children: {
            home: { table: 'address', rows: homes },
            work: { table: 'address', rows: [{ city: 'W' }] },
          },
        },
      ],
    });
    const idOfWork = (result: WritePlan) => rowsOf(result, 'address').find((row) => row.city === 'W')!.id;
    expect(idOfWork(plan(output([{ city: 'A' }, { city: 'B' }])))).toBe(idOfWork(plan(output([{ city: 'A' }]))));
  });

  it('keeps children apart when parents in different tables share an id', () => {
    const result = plan([
      { table: 'user', rows: [{ id: '1', children: { a: { table: 'address', rows: [{ x: 1 }] } } }] },
      { table: 'org', rows: [{ id: '1', children: { a: { table: 'address', rows: [{ x: 2 }] } } }] },
    ]);
    expect(rowsOf(result, 'address')).toHaveLength(2);
  });

  it("doesn't mistake a delimiter in a child key for a deeper path", () => {
    const rows = rowsOf(
      plan({
        table: 'p',
        rows: [
          {
            children: {
              'a","b': { table: 'c', rows: [{ x: 1 }] },
              a: { table: 'c', rows: [{ x: 2 }] },
            },
          },
        ],
      }),
      'c',
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});

describe('rows', () => {
  it('passes _event_seq through as decimal text', () => {
    expect(onlyRow(plan(one({ x: 1 })), 't')._event_seq).toBe('9007199254740993');
  });

  it('converts an undefined column to null, and leaves a missing key missing', () => {
    const row = onlyRow(plan(one({ id: '1', cleared: undefined, kept: 1 })), 't');
    expect(row).toHaveProperty('cleared', null);
    expect(row).not.toHaveProperty('missing');
  });

  it('treats undefined id, _deleted, and children as omitted', () => {
    const result = plan(one({ id: undefined, _deleted: undefined, children: undefined, x: 1 }));
    const row = onlyRow(result, 't');
    expect(row.id).toMatch(UUID_V5);
    expect(row).not.toHaveProperty('_deleted_at');
    expect(row).not.toHaveProperty('children');
    expect(row).not.toHaveProperty('_deleted');
  });

  it('nests child tables, with a foreign key to the immediate parent', () => {
    const result = plan({
      table: 'a',
      rows: [{ id: '1', children: { b: { rows: [{ id: '2', children: { c: { rows: [{ x: 1 }] } } }] } } }],
    });
    expect(onlyRow(result, 'a_b').a_id).toBe('1');
    expect(onlyRow(result, 'a_b_c').a_b_id).toBe('2');
    expect(onlyRow(result, 'a_b_c')).not.toHaveProperty('a_id');
  });

  it('uses the child table hint as the parent name of its own children', () => {
    const result = plan({
      table: 'a',
      rows: [{ id: '1', children: { b: { table: 'hint', rows: [{ id: '2', children: { c: { rows: [{}] } } }] } } }],
    });
    expect(onlyRow(result, 'hint_c').hint_id).toBe('2');
  });

  it('handles a column named like an Object.prototype member', () => {
    const result = plan({
      table: 't',
      column_types: {},
      rows: [{ constructor: 'x', valueof: 1 }],
    });
    expect(tableOf(result, 't').columns).toEqual({ constructor: 'string', valueof: 'number' });
    expect(onlyRow(result, 't').constructor).toBe('x');
  });
});

describe('_deleted', () => {
  it('sets _deleted_at to received_at and still writes the fields', () => {
    const row = onlyRow(plan(one({ id: '1', _deleted: true, reason: 'gone' })), 't');
    expect(row).toEqual({
      id: '1',
      _event_seq: CONTEXT.eventSeq,
      _deleted_at: CONTEXT.receivedAt,
      reason: 'gone',
    });
    expect(row).not.toHaveProperty('_deleted');
  });

  it('works on a child row, with a stable id', () => {
    const output = {
      table: 'order',
      rows: [
        {
          id: 'order_1',
          children: { items: { rows: [{ sku: 'a' }, { _deleted: true, sku: 'b' }] } },
        },
      ],
    };
    const [kept, deleted] = rowsOf(plan(output), 'order_items');
    expect(kept).not.toHaveProperty('_deleted_at');
    expect(deleted).toMatchObject({ _deleted_at: CONTEXT.receivedAt, sku: 'b', order_id: 'order_1' });
    const repeat = rowsOf(plan(output, { eventId: 'other-event' }), 'order_items');
    expect(repeat[1]!.id).toBe(deleted!.id);
  });

  it('has no platform column in columns', () => {
    const result = plan(one({ id: '1', _deleted: true, reason: 'gone' }));
    expect(tableOf(result, 't').columns).toEqual({ reason: 'string' });
  });

  it.each([false, null, 'true', 1])('rejects _deleted: %j', (value) => {
    expect(failure(one({ _deleted: value })).reason).toBe('adapter_error');
  });
});

describe('array output and top-level append', () => {
  it('writes several top-level tables from one event', () => {
    const result = plan([
      { table: 'order', rows: [{ id: 'o1', total: 5 }] },
      { table: 'customer', rows: [{ id: 'c1', name: 'Ada' }] },
    ]);
    expect(result.tables.map(({ table }) => table)).toEqual(['order', 'customer']);
    expect(onlyRow(result, 'order')).not.toHaveProperty('customer_id');
  });

  it('merges objects that name the same table into one entry', () => {
    const result = plan([
      { table: 't', rows: [{ a: 1 }] },
      { table: 't', rows: [{ b: 'x' }] },
    ]);
    expect(result.tables).toHaveLength(1);
    expect(tableOf(result, 't').columns).toEqual({ a: 'number', b: 'string' });
    expect(result.changes.filter((change) => change.kind === 'create_table')).toHaveLength(1);
  });

  it('merges children of different parents into one entry', () => {
    const result = plan({
      table: 'p',
      rows: [
        { id: '1', children: { c: { rows: [{ x: 1 }] } } },
        { id: '2', children: { c: { rows: [{ x: 2 }] } } },
      ],
    });
    expect(rowsOf(result, 'p_c').map((row) => row.p_id)).toEqual(['1', '2']);
  });

  it('ignores append on a top-level object', () => {
    const withAppend = plan({ table: 't', append: true, rows: [{ id: '1', x: 1 }, { x: 2 }] });
    const without = plan({ table: 't', rows: [{ id: '1', x: 1 }, { x: 2 }] });
    expect(withAppend).toEqual(without);
    expect(plan({ table: 't', append: 'not a boolean', rows: [] }).tables).toEqual([]);
  });

  it('plans nothing for no rows, even for a table not seen before', () => {
    expect(plan([])).toEqual({ changes: [], tables: [] });
    expect(plan({ table: 't', rows: [] })).toEqual({ changes: [], tables: [] });
  });
});

describe('a record named twice in one event', () => {
  it('becomes one row, with later keys winning', () => {
    const rows = rowsOf(
      plan([
        { table: 'customer', rows: [{ id: 'c1', name: 'Old', email: 'a@b.c' }] },
        { table: 'customer', rows: [{ id: 'c1', name: 'New', phone: null }] },
      ]),
      'customer',
    );
    expect(rows).toEqual([
      { id: 'c1', _event_seq: CONTEXT.eventSeq, name: 'New', email: 'a@b.c', phone: null },
    ]);
  });

  it('is deleted only if the last mention deletes it', () => {
    const merged = (...rows: unknown[]) => onlyRow(plan({ table: 't', rows }), 't');
    expect(merged({ id: '1', _deleted: true }, { id: '1', x: 1 })).not.toHaveProperty('_deleted_at');
    expect(merged({ id: '1', x: 1 }, { id: '1', _deleted: true })._deleted_at).toBe(CONTEXT.receivedAt);
  });
});

describe('a parent named twice in one event', () => {
  it('updates its children by position, as a repeat in a later event would', () => {
    const repeated = {
      table: 't',
      rows: [
        { id: 'c1', children: { addr: { rows: [{ city: 'A', zip: '1' }] } } },
        { id: 'c1', children: { addr: { rows: [{ city: 'B' }] } } },
      ],
    };
    expect(rowsOf(plan(repeated), 't_addr')).toEqual([
      expect.objectContaining({ city: 'B', zip: '1', t_id: 'c1' }),
    ]);
  });
});

describe('invalid identifiers', () => {
  it.each([
    ['uppercase', 'User'],
    ['leading digit', '1user'],
    ['leading underscore', '_user'],
    ['a space', 'user name'],
    ['a quote', 'user"; DROP TABLE x; --'],
    ['a trailing newline', 'user\n'],
    ['a non-ASCII letter', 'usér'],
    ['nothing', ''],
    ['64 characters', 'a'.repeat(64)],
  ])('rejects a table name with %s', (_description, table) => {
    expect(failure({ table, rows: [] }).reason).toBe('adapter_error');
  });

  it.each([
    ['uppercase', 'Email'],
    ['a leading underscore', '_email'],
    ['a dash', 'e-mail'],
    ['64 characters', 'a'.repeat(64)],
  ])('rejects a column name with %s', (_description, column) => {
    expect(failure(one({ [column]: 1 })).reason).toBe('adapter_error');
  });

  it('accepts names of exactly 63 characters, without truncating', () => {
    const name = 'a'.repeat(63);
    const result = plan({ table: name, rows: [{ [name]: 1 }] });
    expect(tableOf(result, name).columns).toEqual({ [name]: 'number' });
  });

  it('rejects a default child table name that is invalid or too long', () => {
    const child = (key: string) => ({ table: 'p', rows: [{ children: { [key]: { rows: [] } } }] });
    expect(failure(child('Bad')).reason).toBe('adapter_error');
    expect(failure(child('a'.repeat(62))).reason).toBe('adapter_error');
  });

  it('allows any child key when the child names its own table', () => {
    const result = plan({
      table: 'p',
      rows: [{ children: { 'Not An Identifier': { table: 'c', rows: [{ x: 1 }] } } }],
    });
    expect(rowsOf(result, 'c')).toHaveLength(1);
  });

  it('rejects a foreign key that would be too long, rather than truncating it', () => {
    const parent = 'a'.repeat(61);
    const detail = failure({
      table: parent,
      rows: [{ children: { c: { table: 'c', rows: [{ x: 1 }] } } }],
    }).detail;
    expect(detail).toContain('Foreign key');
  });
});

describe('reserved names', () => {
  it.each(['_event_seq', '_column_seq', '_deleted_at', '__proto_x'])(
    'rejects the platform column %s on a row',
    (column) => {
      expect(failure(one({ [column]: 'x' })).reason).toBe('adapter_error');
    },
  );

  it('rejects a child column that collides with the injected foreign key', () => {
    const result = failure({
      table: 'user',
      rows: [{ id: '1', children: { orders: { rows: [{ user_id: 'x' }] } } }],
    });
    expect(result.reason).toBe('adapter_error');
    expect(result.detail).toContain('foreign key');
  });

  it('rejects a foreign key collision even when the value is undefined', () => {
    const result = failure({
      table: 'user',
      rows: [{ id: '1', children: { orders: { rows: [{ user_id: undefined }] } } }],
    });
    expect(result.reason).toBe('adapter_error');
  });

  it('allows a column named like a foreign key on a top-level table', () => {
    const row = onlyRow(plan({ table: 'order', rows: [{ customer_id: 'c1' }] }), 'order');
    expect(row.customer_id).toBe('c1');
  });

  it.each(['id', 'children', '_deleted', '_event_seq'])('rejects %s in column_types', (column) => {
    const result = failure({ table: 't', column_types: { [column]: 'timestamp' }, rows: [] });
    expect(result.reason).toBe('adapter_error');
  });

  it('rejects the injected foreign key in column_types', () => {
    const result = failure({
      table: 'p',
      rows: [{ children: { c: { column_types: { p_id: 'timestamp' }, rows: [] } } }],
    });
    expect(result.reason).toBe('adapter_error');
  });
});

describe('type inference', () => {
  const columnsOf = (row: unknown) => tableOf(plan(one(row)), 't').columns;

  it('infers string, number, and boolean', () => {
    expect(columnsOf({ s: 'x', n: 1.5, b: false })).toEqual({ s: 'string', n: 'number', b: 'boolean' });
  });

  it('infers from the first non-null value', () => {
    const result = plan({ table: 't', rows: [{ x: null }, { x: 'a' }] });
    expect(tableOf(result, 't').columns).toEqual({ x: 'string' });
  });

  it('creates nothing for a column that is only ever null', () => {
    const result = plan({ table: 't', rows: [{ x: null, y: undefined }, { x: null }] });
    expect(tableOf(result, 't').columns).toEqual({});
    expect(result.changes).toEqual([{ kind: 'create_table', table: 't' }]);
  });

  it('treats integers and decimals as one type', () => {
    const result = plan({ table: 't', rows: [{ x: 100 }, { x: 100.5 }] });
    expect(tableOf(result, 't').columns).toEqual({ x: 'number' });
  });

  it('accepts a row with no columns, which still creates its table', () => {
    const result = plan(one({ id: '1' }));
    expect(onlyRow(result, 't')).toEqual({ id: '1', _event_seq: CONTEXT.eventSeq });
    expect(result.changes).toEqual([{ kind: 'create_table', table: 't' }]);
  });

  it('fails on two types for one column within an event, as schema_conflict', () => {
    const result = failure({ table: 't', rows: [{ x: 1 }, { x: 'a' }] });
    expect(result.reason).toBe('schema_conflict');
  });

  it('fails when a foreign key collides with a non-string column in the same event', () => {
    const result = failure([
      { table: 'p_c', rows: [{ p_id: 5 }] },
      { table: 'p', rows: [{ id: '1', children: { c: { rows: [{ x: 1 }] } } }] },
    ]);
    expect(result.reason).toBe('schema_conflict');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('fails on %s', (_name, value) => {
    expect(failure(one({ x: value })).reason).toBe('adapter_error');
  });

  it.each([
    ['a function', () => 1],
    ['a bigint', 1n],
    ['a symbol', Symbol('x')],
    ['a Date', new Date(0)],
  ])('fails on %s', (_name, value) => {
    expect(failure(one({ x: value })).reason).toBe('adapter_error');
  });
});

describe('timestamps', () => {
  const stamped = (value: unknown) => ({
    table: 't',
    column_types: { at: 'timestamp' },
    rows: [{ at: value }],
  });

  it('declares and indexes a timestamp column', () => {
    const result = plan(stamped('2026-11-07T12:00:00Z'));
    expect(tableOf(result, 't').columns).toEqual({ at: 'timestamp' });
    expect(result.changes).toContainEqual({ kind: 'add_index', table: 't', column: 'at' });
  });

  it.each([
    '2026-11-07T12:00:00Z',
    '2026-11-07T12:00:00.123456Z',
    '2026-11-07T12:00:00+05:30',
    '2026-11-07T12:00:00-0800',
    '2026-11-07T12:00:00+05',
    '2026-11-07T12:00Z',
    '2024-02-29T00:00:00Z',
  ])('accepts %s', (value) => {
    expect(onlyRow(plan(stamped(value)), 't').at).toBe(value);
  });

  it.each([
    ['no timezone', '2026-11-07T12:00:00'],
    ['only a date', '2026-11-07'],
    ['not a date', 'yesterday'],
    ['an impossible date', '2026-02-30T00:00:00Z'],
    ['February 29 in a non-leap year', '2026-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-11-07T24:00:00Z'],
    ['minute 60', '2026-11-07T12:60:00Z'],
    ['an offset out of range', '2026-11-07T12:00:00+16:00'],
    ['year 0', '0000-01-01T00:00:00Z'],
    ['a number', 1762516800000],
    ['a boolean', true],
    ['an object', { at: 1 }],
  ])('rejects %s', (_description, value) => {
    expect(failure(stamped(value)).reason).toBe('adapter_error');
  });

  it('allows null in a declared column, which then creates nothing', () => {
    expect(tableOf(plan(stamped(null)), 't').columns).toEqual({});
  });

  it('does not treat an undeclared date string as a timestamp', () => {
    const result = plan(one({ at: '2026-11-07T12:00:00Z' }));
    expect(tableOf(result, 't').columns).toEqual({ at: 'string' });
    expect(result.changes.some((change) => change.kind === 'add_index')).toBe(false);
  });

  it('scopes column_types to its own object', () => {
    const result = plan({
      table: 'p',
      column_types: { at: 'timestamp' },
      rows: [{ at: '2026-11-07T12:00:00Z', children: { c: { rows: [{ at: 'not a date' }] } } }],
    });
    expect(tableOf(result, 'p_c').columns.at).toBe('string');
  });

  it('rejects anything but timestamp in column_types', () => {
    expect(failure({ table: 't', column_types: { x: 'number' }, rows: [] }).reason).toBe('adapter_error');
    expect(failure({ table: 't', column_types: ['x'], rows: [] }).reason).toBe('adapter_error');
  });

  it('fails as schema_conflict when objects disagree on a column in one event', () => {
    const result = failure([stamped('2026-11-07T12:00:00Z'), one({ at: 'plain string' })]);
    expect(result.reason).toBe('schema_conflict');
  });
});

describe('opaque paths', () => {
  const metadata = { any: ['json', 1, null, { nested: true }] };

  it('types an object at a declared path as json, and keeps its value', () => {
    const result = plan(one({ metadata }), { opaquePaths: ['metadata'] });
    expect(tableOf(result, 't').columns).toEqual({ metadata: 'json' });
    expect(onlyRow(result, 't').metadata).toEqual(metadata);
    expect(result.changes).toContainEqual({ kind: 'add_column', table: 't', column: 'metadata', type: 'json' });
  });

  it('types an array at a declared path as json', () => {
    const result = plan(one({ tags: ['a'] }), { opaquePaths: ['tags[]'] });
    expect(tableOf(result, 't').columns).toEqual({ tags: 'json' });
  });

  it('matches a declared path through children, whatever table the child names', () => {
    const output = {
      table: 'user',
      rows: [{ id: '1', children: { orders: { table: 'purchases', rows: [{ metadata }] } } }],
    };
    const result = plan(output, { opaquePaths: ['orders[].metadata'] });
    expect(tableOf(result, 'purchases').columns.metadata).toBe('json');
  });

  it('matches a path inside a top-level array or under a wrapper the adapter lifted away', () => {
    expect(tableOf(plan(one({ metadata }), { opaquePaths: ['[].metadata'] }), 't').columns.metadata).toBe('json');
    expect(
      tableOf(plan(one({ metadata }), { opaquePaths: ['data.object.metadata'] }), 't').columns.metadata,
    ).toBe('json');
  });

  it('types a scalar at a declared path by its own type', () => {
    const result = plan(one({ metadata: 'text' }), { opaquePaths: ['metadata'] });
    expect(tableOf(result, 't').columns).toEqual({ metadata: 'string' });
  });

  it.each([
    ['an object', { a: 1 }],
    ['an array', [1]],
    ['an empty object', {}],
  ])('rejects %s with no declared path', (_description, value) => {
    expect(failure(one({ x: value })).reason).toBe('adapter_error');
  });

  it('rejects an object at a different path from the declared one', () => {
    expect(failure(one({ other: {} }), { opaquePaths: ['metadata'] }).reason).toBe('adapter_error');
  });

  it('lets a shallower column use a deeper declaration of the same name', () => {
    const result = plan(one({ metadata }), { opaquePaths: ['orders[].metadata'] });
    expect(tableOf(result, 't').columns.metadata).toBe('json');
  });

  it('fails as adapter_error, not a throw, on an unparseable declared path', () => {
    const result = failure(one({ x: 1 }), { opaquePaths: ['a..b'] });
    expect(result.reason).toBe('adapter_error');
  });

  it("doesn't let a child column use a declaration for a shallower field", () => {
    const output = { table: 'p', rows: [{ children: { c: { rows: [{ metadata }] } } }] };
    expect(failure(output, { opaquePaths: ['metadata'] }).reason).toBe('adapter_error');
    expect(failure(output, { opaquePaths: ['other[].metadata'] }).reason).toBe('adapter_error');
  });

  it.each([
    ['NaN', { a: [Number.NaN] }],
    ['Infinity', { a: { b: Number.POSITIVE_INFINITY } }],
    ['a nested Date', { a: new Date(0) }],
    ['a nested bigint', [1n]],
    ['a nested undefined', { a: undefined }],
    ['an undefined array element', [undefined]],
  ])('rejects %s inside a json value', (_name, value) => {
    expect(failure(one({ metadata: value }), { opaquePaths: ['metadata'] }).reason).toBe('adapter_error');
  });

  it('fails as adapter_error on a json value that refers to itself', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(failure(one({ metadata: cycle }), { opaquePaths: ['metadata'] }).reason).toBe('adapter_error');
  });
});

describe('malformed output', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'x'],
    ['an array holding a non-object', [1]],
    ['no table', { rows: [] }],
    ['a non-string table', { table: 1, rows: [] }],
    ['no rows', { table: 't' }],
    ['non-array rows', { table: 't', rows: {} }],
    ['a non-object row', { table: 't', rows: [1] }],
    ['an array row', { table: 't', rows: [[]] }],
    ['a null id', one({ id: null })],
    ['a numeric id', one({ id: 5 })],
    ['an empty id', one({ id: '' })],
    ['non-object children', one({ children: [] })],
    ['null children', one({ children: null })],
    ['a non-object child', one({ children: { c: 1 } })],
    ['an undefined child', one({ children: { c: undefined } })],
    ['a null child table', one({ children: { c: { table: null, rows: [] } } })],
    ['a non-boolean child append', one({ children: { c: { append: 'yes', rows: [] } } })],
  ])('fails as adapter_error on %s', (_description, output) => {
    expect(failure(output).reason).toBe('adapter_error');
  });

  it('fails as adapter_error on children that refer to themselves', () => {
    const row: Record<string, unknown> = {};
    row.children = { c: { rows: [row] } };
    expect(failure(one(row)).reason).toBe('adapter_error');
  });
});

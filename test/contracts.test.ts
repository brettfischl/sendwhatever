// Most checks here are type-level. Vitest strips types, so `npm run typecheck` is what enforces
// them: it fails if a shape stops being accepted, or if a `@ts-expect-error` stops being needed.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  StorageError,
  type AdapterPayload,
  type AdapterResult,
  type ChildObject,
  type IntermediateObject,
  type IntermediateRow,
  type LogicalType,
  type RowChildren,
  type SchemaChange,
  type StorageBackend,
  type TableRows,
} from '../src/contracts/index.js';

const row = (fields: IntermediateRow) => fields;
const child = (object: ChildObject) => object;
const top = (object: IntermediateObject) => object;

describe('accepted shapes', () => {
  it('accepts the §8 example adapter output', () => {
    const output: AdapterResult = {
      table: 'user',
      rows: [
        {
          id: 'usr_01J...',
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
    expect(output).toBeDefined();
  });

  it('accepts the rest of what §8 and §12 allow', () => {
    const output: AdapterResult = [
      {
        table: 'order',
        column_types: { placed_at: 'timestamp' },
        rows: [
          {
            id: 'order_1',
            placed_at: '2026-11-07T12:00:00Z',
            total: 12.5,
            paid: false,
            note: null,
            metadata: { any: ['json', 1, null, { nested: true }] },
            children: {
              // A child may omit `table`, and children can nest.
              items: {
                rows: [
                  { id: '1', _deleted: true },
                  { children: { notes: { append: true, rows: [{ text: 'hi' }] } } },
                ],
              },
            },
          },
          // The §12 example adapter sets `children` to undefined when there are none.
          { id: 'order_2', children: undefined },
        ],
      },
      { table: 'customer', rows: [] },
    ];
    expect(output).toHaveLength(2);
  });

  it('lets a top-level object be used as a child, but not the reverse', () => {
    const asChild: ChildObject = top({ table: 'a', rows: [] });
    // @ts-expect-error a child may have no table, so it can't be a top-level object
    const asTop: IntermediateObject = child({ rows: [] });
    expect([asChild, asTop]).toHaveLength(2);
  });

  it('accepts a sandbox-style payload', () => {
    const payload: AdapterPayload = {
      data: null,
      request: { method: 'DELETE', path: '/orders/1', query: '', headers: {} },
    };
    expect(payload.data).toBeNull();
  });
});

describe('rejected shapes', () => {
  it('rejects a bad top-level object', () => {
    // @ts-expect-error table is required at the top level
    top({ rows: [] });
    // @ts-expect-error rows is required
    top({ table: 'user' });
    // @ts-expect-error column_types declares only timestamps
    top({ table: 'user', rows: [], column_types: { amount: 'number' } });
    // @ts-expect-error a row is not an adapter result
    const result: AdapterResult = { id: '1' };
    expect(result).toBeDefined();
  });

  it('rejects a child without rows', () => {
    // @ts-expect-error rows is required on a child too
    child({ table: 'user_orders' });
    // @ts-expect-error a child's rows must be an array
    row({ children: { orders: { rows: { sku: 'A1' } } } });
  });

  it('rejects bad values on the typed row keys', () => {
    // @ts-expect-error id is a string
    row({ id: 5 });
    // @ts-expect-error _deleted is only ever true
    row({ _deleted: false });
    // @ts-expect-error children maps keys to child objects
    row({ children: 'orders' });
  });

  it('rejects column values JSON cannot hold', () => {
    // @ts-expect-error Dates are not values; a timestamp is an ISO 8601 string
    row({ placed_at: new Date() });
    // @ts-expect-error large integers reach adapters as strings, so bigint is never valid
    row({ big: 1n });
    // @ts-expect-error functions are not values
    row({ fn: () => 1 });
    // @ts-expect-error nor when nested in an opaque value
    row({ metadata: { placed_at: new Date() } });
  });

  it('rejects non-additive schema changes and removed fields', () => {
    // @ts-expect-error SchemaChange cannot express a drop (§9)
    const drop: SchemaChange = { kind: 'drop_table', table: 'user' };
    // @ts-expect-error integer and float are one logical type (§9)
    const type: LogicalType = 'integer';
    const tables: TableRows = {
      table: 'user',
      columns: {},
      rows: [],
      // @ts-expect-error child-set replacement was removed
      replaceChildrenOf: 'user_1',
    };
    expect([drop, type, tables]).toHaveLength(3);
  });
});

describe('reading a row', () => {
  it('keeps the typed keys precise, and makes callers narrow columns', () => {
    const value = row({ id: '1', email: 'ada@example.com' });
    expectTypeOf(value.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(value._deleted).toEqualTypeOf<true | undefined>();
    expectTypeOf(value.children).toEqualTypeOf<RowChildren | undefined>();
    expectTypeOf(value.children?.orders?.rows).toEqualTypeOf<IntermediateRow[] | undefined>();
    expectTypeOf(value.email).not.toBeAny();
    // @ts-expect-error a column must be narrowed before use
    value.email.toUpperCase();
  });
});

describe('StorageBackend', () => {
  it('can be implemented from the interface alone', async () => {
    const backend: StorageBackend = {
      capabilities: { atomicWrites: true, idempotency: 'immediate' },
      provision: async () => ({ user: 'readonly' }),
      applySchema: async () => {},
      write: async () => {},
      health: async () => {},
    };
    await expect(backend.provision({ namespace: 'a', connection: {} })).resolves.toEqual({
      user: 'readonly',
    });
  });
});

describe('StorageError', () => {
  it('carries its classification and cause', () => {
    const cause = new Error('connection reset');
    const error = new StorageError('write failed', { retryable: true, cause });
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StorageError');
    expect(error.message).toBe('write failed');
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });

  it('leaves cause unset when none is given', () => {
    const error = new StorageError('bad value', { retryable: false });
    expect(error.retryable).toBe(false);
    expect('cause' in error).toBe(false);
  });

  it('requires a classification', () => {
    // @ts-expect-error every failure must be classified (§11.2)
    const unclassified = () => new StorageError('write failed');
    expect(unclassified).toBeTypeOf('function');
  });
});

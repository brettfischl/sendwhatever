import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  StorageError,
  type AdapterResult,
  type SchemaChange,
  type StorageBackend,
  type StoreConfig,
} from '../src/contracts/index.js';
import { applyPlanSchema, planWrite, type WritePlan } from '../src/planner/index.js';
import {
  findConflicts,
  findMissingChanges,
  resolveNullColumns,
  schemaLockName,
} from '../src/planner/registry.js';

const pool = new pg.Pool({ connectionString: loadConfig().appDatabaseUrl });
const accountId = randomUUID();
const storeId = randomUUID();
const store: StoreConfig = { namespace: 'registry_test', connection: {} };
const target = { storeId, store };

class FakeBackend implements Pick<StorageBackend, 'applySchema'> {
  calls: SchemaChange[][] = [];
  /** Runs inside each applySchema call, before it returns. */
  during: () => Promise<void> = async () => undefined;

  async applySchema(_store: StoreConfig, changes: SchemaChange[]): Promise<void> {
    this.calls.push(changes);
    await this.during();
  }
}

function plan(output: unknown, opaquePaths: string[] = []): WritePlan {
  const result = planWrite(output as AdapterResult, {
    eventId: randomUUID(),
    eventSeq: '1',
    receivedAt: '2026-11-07T12:00:00Z',
    opaquePaths,
  });
  if (!result.ok) throw new Error(result.detail);
  return result.plan;
}

async function registry(): Promise<string[]> {
  const result = await pool.query<{ entry: string }>(
    `SELECT table_name || '.' || column_name || ':' || logical_type AS entry
     FROM data_columns WHERE store_id = $1 ORDER BY 1`,
    [storeId],
  );
  return result.rows.map((row) => row.entry);
}

/** True if the promise settles within a moment. */
async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150));
  return Promise.race([promise.then(() => true), timer]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO accounts (id, slug) VALUES ($1, $2)`, [accountId, `registry-${accountId}`]);
  await pool.query(
    `INSERT INTO account_stores (id, account_id, generation, backend, connection, namespace, status)
     VALUES ($1, $2, 1, 'fake', '{}', 'registry_test', 'active')`,
    [storeId, accountId],
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM data_columns WHERE store_id = $1', [storeId]);
});

afterAll(async () => {
  await pool.query('DELETE FROM data_columns WHERE store_id = $1', [storeId]);
  await pool.query('DELETE FROM account_stores WHERE id = $1', [storeId]);
  await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
  await pool.end();
});

describe('comparing a plan with the registry', () => {
  const registered = new Map([['t', new Map([['id', 'string'], ['x', 'number']] as const)]]);

  it('finds a type conflict, but not a matching or new column', () => {
    const tables = [{ table: 't', columns: { x: 'string', y: 'boolean' } as const, rows: [] }];
    expect(findConflicts(tables, registered)).toEqual([
      't.x is registered as number, but this event has string',
    ]);
    const matching = [{ table: 't', columns: { x: 'number' } as const, rows: [] }];
    expect(findConflicts(matching, registered)).toEqual([]);
  });

  it('keeps only changes the registry lacks, and treats an index as part of its column', () => {
    const changes: SchemaChange[] = [
      { kind: 'create_table', table: 't' },
      { kind: 'add_column', table: 't', column: 'x', type: 'number' },
      { kind: 'add_index', table: 't', column: 'x' },
      { kind: 'add_column', table: 't', column: 'y', type: 'string' },
      { kind: 'add_index', table: 't', column: 'y' },
      { kind: 'create_table', table: 'u' },
    ];
    expect(findMissingChanges(changes, registered)).toEqual([
      { kind: 'add_column', table: 't', column: 'y', type: 'string' },
      { kind: 'add_index', table: 't', column: 'y' },
      { kind: 'create_table', table: 'u' },
    ]);
  });

  it('drops a null for an unknown column, and types a null for a registered one', () => {
    const [table] = resolveNullColumns(
      [
        {
          table: 't',
          columns: { y: 'string' },
          rows: [
            { id: '1', _event_seq: '1', _deleted_at: 'then', x: null, unknown: null, y: 'a' },
            { id: '2', _event_seq: '1', unknown: null },
          ],
        },
      ],
      registered,
    );
    expect(table!.columns).toEqual({ x: 'number', y: 'string' });
    expect(table!.rows).toEqual([
      { id: '1', _event_seq: '1', _deleted_at: 'then', x: null, y: 'a' },
      { id: '2', _event_seq: '1' },
    ]);
  });

  it("isn't confused by a column named like an Object.prototype member", () => {
    const [table] = resolveNullColumns(
      [{ table: 't', columns: {}, rows: [{ id: '1', _event_seq: '1', constructor: null }] }],
      registered,
    );
    expect(table!.columns).toEqual({});
    expect(Object.keys(table!.rows[0]!)).toEqual(['id', '_event_seq']);
  });
});

describe('applyPlanSchema', () => {
  it('applies the changes to the backend and records them, including the table', async () => {
    const backend = new FakeBackend();
    const input = plan({
      table: 'user',
      rows: [{ id: '1', email: 'a', children: { orders: { rows: [{ amount: 5 }] } } }],
    });

    const result = await applyPlanSchema(pool, backend, target, input);

    expect(result).toEqual({ ok: true, tables: input.tables });
    expect(backend.calls).toEqual([input.changes]);
    expect(await registry()).toEqual([
      'user.email:string',
      'user.id:string',
      'user_orders.amount:number',
      'user_orders.id:string',
      'user_orders.user_id:string',
    ]);
  });

  it('does nothing to the backend on a repeat', async () => {
    const backend = new FakeBackend();
    const input = plan({ table: 't', rows: [{ x: 1 }] });
    await applyPlanSchema(pool, backend, target, input);
    backend.calls = [];

    expect((await applyPlanSchema(pool, backend, target, input)).ok).toBe(true);
    expect(backend.calls).toEqual([]);
  });

  it('applies only the new column on a later event', async () => {
    const backend = new FakeBackend();
    await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
    backend.calls = [];

    await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 2, y: 'a' }] }));
    expect(backend.calls).toEqual([[{ kind: 'add_column', table: 't', column: 'y', type: 'string' }]]);
  });

  it('remembers a table with no columns of its own', async () => {
    const backend = new FakeBackend();
    const input = plan({ table: 't', rows: [{ id: '1' }] });
    await applyPlanSchema(pool, backend, target, input);
    backend.calls = [];
    await applyPlanSchema(pool, backend, target, input);
    expect(backend.calls).toEqual([]);
    expect(await registry()).toEqual(['t.id:string']);
  });

  it('keeps registries of different stores apart', async () => {
    const otherStoreId = randomUUID();
    await pool.query(
      `INSERT INTO account_stores (id, account_id, generation, backend, connection, namespace, status)
       VALUES ($1, $2, 2, 'fake', '{}', 'registry_test_2', 'building')`,
      [otherStoreId, accountId],
    );
    try {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      const result = await applyPlanSchema(
        pool,
        backend,
        { storeId: otherStoreId, store },
        plan({ table: 't', rows: [{ x: 'text' }] }),
      );
      expect(result.ok).toBe(true);
    } finally {
      await pool.query('DELETE FROM data_columns WHERE store_id = $1', [otherStoreId]);
      await pool.query('DELETE FROM account_stores WHERE id = $1', [otherStoreId]);
    }
  });

  describe('type conflicts', () => {
    it('returns schema_conflict and changes nothing, even with new columns in the event', async () => {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      backend.calls = [];
      const before = await registry();

      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan([
          { table: 'new_table', rows: [{ y: 1 }] },
          { table: 't', rows: [{ x: 'text', z: true }] },
        ]),
      );

      expect(result).toEqual({
        ok: false,
        reason: 'schema_conflict',
        detail: 't.x is registered as number, but this event has string',
      });
      expect(backend.calls).toEqual([]);
      expect(await registry()).toEqual(before);
    });

    it('treats a timestamp against a registered string as a conflict, without coercing', async () => {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ at: 'text' }] }));
      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan({ table: 't', column_types: { at: 'timestamp' }, rows: [{ at: '2026-11-07T12:00:00Z' }] }),
      );
      expect(result).toMatchObject({ ok: false, reason: 'schema_conflict' });
    });

    it('has no conflict when a scalar comes first at an opaque path, then an object', async () => {
      const backend = new FakeBackend();
      const opaque = ['metadata'];
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ metadata: 'n/a' }] }, opaque));
      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan({ table: 't', rows: [{ metadata: { a: 1 } }] }, opaque),
      );
      expect(result.ok).toBe(true);
      expect(await registry()).toEqual(['t.id:string', 't.metadata:json']);
    });

    it('allows null against any registered type', async () => {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      const result = await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ id: '1', x: null }] }));
      expect(result).toEqual({
        ok: true,
        tables: [
          { table: 't', columns: { x: 'number' }, rows: [{ id: '1', _event_seq: '1', x: null }] },
        ],
      });
    });
  });

  // A backend throws a permanent error on any row key missing from `columns`.
  describe('every row key is a listed column', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('drops %s on an unregistered column, and creates nothing', async (_name, value) => {
      const backend = new FakeBackend();
      const result = await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ id: '1', x: value }] }));
      expect(result).toEqual({
        ok: true,
        tables: [{ table: 't', columns: {}, rows: [{ id: '1', _event_seq: '1' }] }],
      });
      expect(await registry()).toEqual(['t.id:string']);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('declares %s on a registered column with its type, so the clear lands', async (_name, value) => {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      backend.calls = [];
      const result = await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ id: '1', x: value }] }));
      expect(result).toEqual({
        ok: true,
        tables: [{ table: 't', columns: { x: 'number' }, rows: [{ id: '1', _event_seq: '1', x: null }] }],
      });
      expect(backend.calls).toEqual([]);
    });

    it('keeps a null when another row in the event gives the column a value', async () => {
      const backend = new FakeBackend();
      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan({ table: 't', rows: [{ id: '1', x: null }, { id: '2', x: 'a' }] }),
      );
      expect(result).toEqual({
        ok: true,
        tables: [
          {
            table: 't',
            columns: { x: 'string' },
            rows: [
              { id: '1', _event_seq: '1', x: null },
              { id: '2', _event_seq: '1', x: 'a' },
            ],
          },
        ],
      });
    });

    it('keeps platform keys on the row and out of columns', async () => {
      const backend = new FakeBackend();
      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan({ table: 't', rows: [{ id: '1', _deleted: true, x: 1 }] }),
      );
      expect(result).toEqual({
        ok: true,
        tables: [
          {
            table: 't',
            columns: { x: 'number' },
            rows: [{ id: '1', _event_seq: '1', _deleted_at: '2026-11-07T12:00:00Z', x: 1 }],
          },
        ],
      });
    });

    it('resolves registered, new, and unknown columns on one row', async () => {
      const backend = new FakeBackend();
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      backend.calls = [];
      const result = await applyPlanSchema(
        pool,
        backend,
        target,
        plan({ table: 't', rows: [{ id: '1', x: null, y: 'new', z: null }] }),
      );
      expect(result).toEqual({
        ok: true,
        tables: [
          {
            table: 't',
            columns: { y: 'string', x: 'number' },
            rows: [{ id: '1', _event_seq: '1', x: null, y: 'new' }],
          },
        ],
      });
      expect(backend.calls).toEqual([[{ kind: 'add_column', table: 't', column: 'y', type: 'string' }]]);
    });
  });

  describe('failure ordering', () => {
    it('applies to the backend before updating the registry', async () => {
      const backend = new FakeBackend();
      let registeredDuringApply: string[] | undefined;
      backend.during = async () => {
        registeredDuringApply = await registry();
      };
      await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      expect(registeredDuringApply).toEqual([]);
      expect(await registry()).toEqual(['t.id:string', 't.x:number']);
    });

    it('rethrows a retryable StorageError, records nothing, and reapplies on the retry', async () => {
      const backend = new FakeBackend();
      const input = plan({ table: 't', rows: [{ x: 1 }] });
      backend.during = async () => {
        throw new StorageError('unavailable', { retryable: true });
      };
      await expect(applyPlanSchema(pool, backend, target, input)).rejects.toThrow('unavailable');
      expect(await registry()).toEqual([]);

      backend.during = async () => undefined;
      backend.calls = [];
      expect((await applyPlanSchema(pool, backend, target, input)).ok).toBe(true);
      expect(backend.calls).toEqual([input.changes]);
      expect(await registry()).toEqual(['t.id:string', 't.x:number']);
    });

    it('rethrows an error that is not a StorageError', async () => {
      const backend = new FakeBackend();
      backend.during = async () => {
        throw new Error('bug');
      };
      await expect(
        applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] })),
      ).rejects.toThrow('bug');
    });

    it('returns write_error for a permanent StorageError, and records nothing', async () => {
      const backend = new FakeBackend();
      backend.during = async () => {
        throw new StorageError('column limit reached', { retryable: false });
      };
      const result = await applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      expect(result).toEqual({ ok: false, reason: 'write_error', detail: 'column limit reached' });
      expect(await registry()).toEqual([]);
    });

    it('releases the lock and the connection after a failure', async () => {
      const backend = new FakeBackend();
      backend.during = async () => {
        throw new StorageError('unavailable', { retryable: true });
      };
      const input = plan({ table: 't', rows: [{ x: 1 }] });
      await expect(applyPlanSchema(pool, backend, target, input)).rejects.toThrow();
      backend.during = async () => undefined;
      expect(await settlesSoon(applyPlanSchema(pool, backend, target, input))).toBe(true);
      expect(pool.idleCount).toBe(pool.totalCount);
    });
  });

  describe('concurrency', () => {
    /** Holds the store's schema lock on its own connection until the returned function is called. */
    async function holdLock(): Promise<() => Promise<void>> {
      const client = await pool.connect();
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [schemaLockName(storeId)]);
      return async () => {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [schemaLockName(storeId)]);
        client.release();
      };
    }

    it("doesn't take the lock when nothing needs changing", async () => {
      const backend = new FakeBackend();
      const input = plan({ table: 't', rows: [{ x: 1 }] });
      await applyPlanSchema(pool, backend, target, input);

      const release = await holdLock();
      try {
        expect(await settlesSoon(applyPlanSchema(pool, backend, target, input))).toBe(true);
      } finally {
        await release();
      }
    });

    it('waits for the lock when a change is needed', async () => {
      const backend = new FakeBackend();
      const release = await holdLock();
      const pending = applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] }));
      try {
        expect(await settlesSoon(pending)).toBe(false);
        expect(backend.calls).toEqual([]);
      } finally {
        await release();
      }
      expect((await pending).ok).toBe(true);
    });

    it('throws on a lock timeout, so the job stays queued, and leaves nothing behind', async () => {
      const backend = new FakeBackend();
      const input = plan({ table: 't', rows: [{ x: 1 }] });
      const release = await holdLock();
      try {
        await expect(
          applyPlanSchema(pool, backend, target, input, { lockTimeoutMs: 50 }),
        ).rejects.toMatchObject({ code: '55P03' });
        expect(backend.calls).toEqual([]);
        expect(await registry()).toEqual([]);
      } finally {
        await release();
      }

      expect((await applyPlanSchema(pool, backend, target, input)).ok).toBe(true);
      const setting = await pool.query<{ lock_timeout: string }>('SHOW lock_timeout');
      expect(setting.rows[0]!.lock_timeout).toBe('0');
    });

    it('applies once when workers race to add the same column', async () => {
      const backend = new FakeBackend();
      const input = plan({ table: 't', rows: [{ x: 1 }] });
      const results = await Promise.all(
        Array.from({ length: 5 }, () => applyPlanSchema(pool, backend, target, input)),
      );
      expect(results.every((result) => result.ok)).toBe(true);
      expect(backend.calls).toHaveLength(1);
    });

    it('lets one worker win when workers race with different types', async () => {
      const backend = new FakeBackend();
      const results = await Promise.all([
        applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 1 }] })),
        applyPlanSchema(pool, backend, target, plan({ table: 't', rows: [{ x: 'text' }] })),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok && result.reason === 'schema_conflict')).toHaveLength(1);
      expect(backend.calls).toHaveLength(1);
    });
  });
});

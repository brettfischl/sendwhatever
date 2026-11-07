// Tests the three issues reported on src/adapters/carry.ts directly, with correct output built by hand,
// so a verdict doesn't depend on what the model happened to write. Run: tsx spike/verify-carry-claims.ts
import type { TableRows } from '../src/contracts/index.js';
import { findDroppedValues } from '../src/adapters/carry.js';
import { uniquify } from './evaluate.js';

function table(name: string, columns: TableRows['columns'], rows: Record<string, unknown>[]): TableRows {
  return { table: name, columns, rows: rows.map((row, index) => ({ _event_seq: '1', id: String(index), ...row })) } as TableRows;
}

function show(name: string, payload: unknown, tables: TableRows[]): void {
  const dropped = findDroppedValues(payload, tables, []);
  console.log(`${name}: ${dropped.length === 0 ? 'passes' : `FAILS ${JSON.stringify(dropped.map((d) => `${d.path} = ${d.value}`))}`}`);
}

// Line 128: the same customer embedded twice, once with a null field. A correct merge gives one row.
show(
  'null variant of the same object, merged to one row',
  { orders: [{ customer: { id: 'c1', name: 'Ada', fax: null } }, { customer: { id: 'c1', name: 'Ada' } }] },
  [table('customers', { name: 'string' }, [{ id: 'c1', name: 'Ada' }])],
);
show(
  'control: identical object repeated, merged to one row',
  { orders: [{ customer: { id: 'c1', name: 'Ada' } }, { customer: { id: 'c1', name: 'Ada' } }] },
  [table('customers', { name: 'string' }, [{ id: 'c1', name: 'Ada' }])],
);

// Line 86: 10:00 PST is 18:00Z. An adapter that normalizes it correctly writes the true instant.
const pst = new Date('Nov 12, 2026 10:00 PST').toISOString();
console.log(`Node reads "Nov 12, 2026 10:00 PST" as ${pst}`);
show('named zone, normalized correctly', { at: 'Nov 12, 2026 10:00 PST' }, [table('t', { at: 'timestamp' }, [{ at: pst }])]);
show('named zone, control with an explicit offset', { at: 'Nov 12, 2026 10:00 -08:00' }, [
  table('t', { at: 'timestamp' }, [{ at: new Date('Nov 12, 2026 10:00 -08:00').toISOString() }]),
]);

// Line 81: fractional epoch seconds. toISOString keeps milliseconds, so anything finer can't match.
for (const value of [1794508200.123, 1794508200.1234, 1794508200.5678]) {
  const iso = new Date(value * 1000).toISOString();
  show(`fractional epoch ${value} -> ${iso}`, { at: value }, [table('t', { at: 'timestamp' }, [{ at: iso }])]);
}

// Control for the unique-value check in evaluate.ts: `b` is dropped and an unrelated column happens to
// hold the same value. The carry check can't see it, as carry.ts says. With unique values it must show.
const hidden = { a: 'x', b: 'x' };
const hiding = (body: { a: string }) => [table('t', { a: 'string', copy: 'string' }, [{ a: body.a, copy: body.a }])];
show('control: dropped b, hidden by an equal value', hidden, hiding(hidden));
const unique = uniquify(hidden) as { a: string };
show('control: the same adapter on unique values', unique, hiding(unique));

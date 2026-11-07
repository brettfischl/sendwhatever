// The validation gate (PRD §12.1), the main protection against a bad adapter, since adapters can go
// live with no human review. This file has no database access: `store.ts` loads what it needs, and the
// generator can call `runGate` directly. Failures are collected rather than stopping at the first, so
// the LLM can fix them all in one retry. Their text quotes payload values, which are data.
import { isDeepStrictEqual } from 'node:util';
import type { AdapterRequest, AdapterResult, SchemaChange } from '../contracts/index.js';
import { OpaquePathError, parseOpaquePath } from '../fingerprint/index.js';
import { planWrite, type WritePlan } from '../planner/index.js';
import { findConflicts, findMissingChanges, type RegisteredColumns } from '../planner/registry.js';
import { runAdapter, type SandboxFailureKind, type SandboxLimits, type SandboxResult } from '../sandbox/index.js';
import { findDroppedValues, parseBodyLikeSandbox } from './carry.js';

export type GateFailureCode =
  /** Nothing to validate against. An adapter never passes an empty sample. */
  | 'no_samples'
  | 'invalid_opaque_path'
  /** It threw, timed out, ran out of memory, or returned something that can't leave the sandbox. */
  | 'run_failed'
  | 'nondeterministic'
  /** Rejected by the write planner: structure, identifiers, reserved names, or timestamps. */
  | 'invalid_output'
  | 'type_conflict'
  /** A column named like `product_id` holds a number. A numeric `id` is `invalid_output`, from the planner. */
  | 'numeric_id'
  /** A string column holds an ISO 8601 date-time, and isn't declared `timestamp`. */
  | 'undeclared_timestamp'
  /** `op = delete`, and a top-level row lacks `_deleted: true` or an `id`, or there are no rows. */
  | 'delete_row'
  | 'dropped_field'
  /** A column the version being replaced wrote for this sample is no longer written. */
  | 'dropped_column'
  /** A table name follows the request path, rather than being fixed in the code. */
  | 'computed_table'
  /** Two table names differ only in singular and plural, such as `products_image` and `products_images`. */
  | 'split_table';

export interface GateFailure {
  code: GateFailureCode;
  detail: string;
  /** The sample it happened on, when there is one. */
  eventId?: string;
}

export interface GateSample {
  eventId: string;
  /** The raw body text, or null for no body. */
  body: string | null;
  request: AdapterRequest;
}

export interface GateAdapter {
  code: string;
  op: 'write' | 'delete';
  opaquePaths: readonly string[];
}

export interface EarlierVersion {
  id: string;
  code: string;
  opaquePaths: readonly string[];
}

export interface GateInput {
  adapter: GateAdapter;
  samples: readonly GateSample[];
  /** `data_columns` for each of the account's live stores, keyed by store id. */
  registries: ReadonlyMap<string, RegisteredColumns>;
  /** The active version this adapter would replace. Omit if there is none. */
  earlier?: EarlierVersion;
}

export interface GateOptions {
  limits?: SandboxLimits;
  /** Replaces the sandbox, in tests. */
  run?: typeof runAdapter;
}

export interface SampleReport {
  eventId: string;
  /** What the adapter returned, if it ran. */
  output?: unknown;
  /** What this sample would add to any live store. */
  schemaChanges?: SchemaChange[];
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
  samples: SampleReport[];
  /** The version this was checked against. Activation confirms it's still the active one. */
  replacing: string | null;
}

/** A plan's placeholders. Nothing is written, and ids derived from them are only compared within a run. */
const PLAN_SEQ = '1';
const PLAN_RECEIVED_AT = '1970-01-01T00:00:00.000Z';
const MAX_DROPPED_REPORTED = 20;
const MAX_QUOTED_VALUE_LENGTH = 40;
/** A full date-time. It needs the time part, so plain dates and ordinary text never match. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const RETRIED_FAILURES: ReadonlySet<SandboxFailureKind> = new Set<SandboxFailureKind>(['timeout', 'memory_limit', 'crashed']);
const MAX_TABLES_QUOTED = 5;
const MAX_IDENTIFIER_LENGTH = 63;
/** Each is closed under `alternatePath`'s shift, so hex stays hex, and a number stays a number. */
const PATH_ALPHABETS = ['0123456789', 'abcdef', 'ghijklmnopqrstuvwxyz', 'ABCDEF', 'GHIJKLMNOPQRSTUVWXYZ'];

/** Rejects bad syntax and any path that would collapse the root or an array of the root (§7.1). */
export function checkOpaquePaths(paths: readonly string[]): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const path of paths) {
    try {
      parseOpaquePath(path);
    } catch (error) {
      if (!(error instanceof OpaquePathError)) throw error;
      failures.push({ code: 'invalid_opaque_path', detail: error.message });
    }
  }
  return failures;
}

/** Runs the adapter against every sample, and passes only if nothing failed on any of them. */
export async function runGate(input: GateInput, options: GateOptions = {}): Promise<GateResult> {
  const replacing = input.earlier?.id ?? null;
  const failures = checkOpaquePaths(input.adapter.opaquePaths);
  if (failures.length > 0) return { ok: false, failures, samples: [], replacing };
  if (input.samples.length === 0) {
    failures.push({ code: 'no_samples', detail: 'There are no events of this shape to validate against.' });
    return { ok: false, failures, samples: [], replacing };
  }

  const reports: SampleReport[] = [];
  // Samples must also agree with each other. Whichever event wrote first would register the type, and
  // the other would then land in quarantine.
  const seenAcrossSamples: RegisteredColumns = new Map();
  for (const sample of input.samples) {
    const { report, failures: sampleFailures } = await checkSample(input, sample, seenAcrossSamples, options);
    reports.push(report);
    failures.push(...sampleFailures.map((failure) => ({ ...failure, eventId: sample.eventId })));
  }
  return { ok: failures.length === 0, failures, samples: reports, replacing };
}

async function checkSample(
  input: GateInput,
  sample: GateSample,
  seenAcrossSamples: RegisteredColumns,
  options: GateOptions,
): Promise<{ report: SampleReport; failures: GateFailure[] }> {
  const { adapter, earlier, registries } = input;
  const run = (code: string, request = sample.request) =>
    (options.run ?? runAdapter)({ code, body: sample.body, request }, options.limits);
  const [first, second] = await Promise.all([run(adapter.code), run(adapter.code)]);

  const report: SampleReport = { eventId: sample.eventId };
  const failed = (code: GateFailureCode, detail: string) => ({ report, failures: [{ code, detail }] });

  if (!first.ok) return failed('run_failed', `${first.kind}: ${first.detail}`);
  report.output = first.output;
  if (!second.ok) {
    return failed('nondeterministic', `The first run succeeded, but the second failed. ${second.kind}: ${second.detail}`);
  }
  if (!isDeepStrictEqual(first.output, second.output)) {
    return failed(
      'nondeterministic',
      `Two runs on the same payload differ at ${firstDifference(first.output, second.output, '$')}.`,
    );
  }

  const planned = plan(first.output, sample, adapter.opaquePaths);
  if (!planned.ok) {
    return failed(planned.reason === 'schema_conflict' ? 'type_conflict' : 'invalid_output', planned.detail);
  }
  report.schemaChanges = missingAnywhere(planned.plan.changes, registries);

  const failures: GateFailure[] = [
    ...checkTypes(planned.plan, registries, seenAcrossSamples),
    ...checkNumericIds(planned.plan),
    ...checkUndeclaredTimestamps(planned.plan, registries),
    ...(adapter.op === 'delete' ? checkDeleteRows(first.output) : []),
    ...checkCarry(sample, planned.plan, adapter.opaquePaths),
    ...(await checkFixedTables(first.output, sample.request, (request) => run(adapter.code, request))),
    ...checkSplitTables(first.output, registries),
  ];

  if (earlier) {
    // Running out of time or memory can come from load rather than the code, so it gets a second try.
    let earlierRun = await run(earlier.code);
    if (!earlierRun.ok && RETRIED_FAILURES.has(earlierRun.kind)) earlierRun = await run(earlier.code);
    // An earlier version that still can't handle this sample wrote nothing for it, so there's nothing
    // to keep. This can't block a fix for an adapter that really does time out.
    if (earlierRun.ok) {
      const earlierPlan = plan(earlierRun.output, sample, earlier.opaquePaths);
      if (earlierPlan.ok) failures.push(...checkEarlierColumns(earlierPlan.plan, planned.plan));
    }
  }
  return { report, failures };
}

/**
 * Catches a table named after the request, such as `segs[1]` of `/ingest/shopify`. A prompt rule can't stop
 * it, and a reused schema spreads the name to later adapters.
 *
 * Names that move on one altered path may still be literals the adapter chooses between, which is fine, so
 * a second path decides: literals land on the same fallback both times, and a computed name follows the path
 * to somewhere new. A failed run on an altered path says nothing about the names, so it isn't held against
 * the adapter. Those paths are made up, and with the first segment picking the source, production never sends
 * them to this adapter.
 */
async function checkFixedTables(
  output: unknown,
  request: AdapterRequest,
  run: (request: AdapterRequest) => Promise<SandboxResult>,
): Promise<GateFailure[]> {
  const tablesOn = async (path: string) => {
    const result = await run({ ...request, path });
    return result.ok ? tableNames(result.output) : null;
  };
  const firstPath = alternatePath(request.path, 1);
  // A bare `/ingest` has nothing to change while keeping its segment count.
  if (firstPath === request.path) return [];

  const original = tableNames(output);
  const altered = await tablesOn(firstPath);
  if (altered === null || isDeepStrictEqual(altered, original)) return [];
  const again = await tablesOn(alternatePath(request.path, 2));
  if (again === null || isDeepStrictEqual(again, altered)) return [];
  return [{
    code: 'computed_table',
    detail:
      `Table names follow the request path: this path writes ${quoteTables(original, altered)}, and a different ` +
      `one writes ${quoteTables(altered, original)} instead. Write every table name, including a child's, as a fixed string literal, never ` +
      'computed from payload.request. Name each table for the entity the event describes, from its body and ' +
      'headers, not for the path.',
  }];
}

/**
 * Catches one entity split across tables whose names differ only in singular and plural, such as
 * `products_image` beside `products_images`, which the model produces for a featured record and the list
 * it comes from. Prompt rule 5 alone doesn't stop it.
 *
 * Names are compared by `singularName`, which misses some splits rather than risk joining distinct
 * entities. Two names that are both already registered pass, since rejecting can't undo a split already in
 * the schema, and the adapter may have to keep writing both.
 */
function checkSplitTables(output: unknown, registries: ReadonlyMap<string, RegisteredColumns>): GateFailure[] {
  const registered = new Set([...registries.values()].flatMap((tables) => [...tables.keys()]));
  const registeredBySingular = groupBySingular(registered);
  const failures: GateFailure[] = [];
  for (const [singular, names] of groupBySingular(tableNames(output))) {
    const existing = (registeredBySingular.get(singular) ?? []).filter((name) => !names.includes(name));
    if (names.length > 1) {
      if (names.every((name) => registered.has(name))) continue;
      const keep = names.filter((name) => registered.has(name));
      failures.push({
        code: 'split_table',
        detail:
          `Tables ${quoteNames(names)} hold the same entity, one singular and one plural. Write it to one ` +
          `table${keep.length > 0 ? `, the existing ${quoteNames(keep)}` : ', named in the plural'}, keyed by its ` +
          'id. When a payload has one record and a list of the same kind, such as image and images, write the ' +
          'single one as a row of that table too, and refer to it from the parent with a column such as ' +
          'featured_image_id.',
      });
    } else if (!registered.has(names[0]!) && existing.length > 0) {
      failures.push({
        code: 'split_table',
        detail:
          `Table ${quoteNames(names)} is new, but the registered table ${quoteNames(existing)} holds the same ` +
          'entity. Write to the registered table instead, keyed by the same id.',
      });
    }
  }
  return failures;
}

function groupBySingular(names: Iterable<string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const singular = singularName(name);
    groups.set(singular, [...(groups.get(singular) ?? []), name]);
  }
  return groups;
}

/**
 * Singularises each underscore-separated word, so `products_images`, `product_images`, and `products_image`
 * all become `product_image`. It is deliberately simple: an unknown plural is left alone, which can only miss
 * a split, and words ending in `ss`, `us`, or `is`, such as `address`, `status`, and `analysis`, are kept.
 */
export function singularName(name: string): string {
  return name.split('_').map(singularWord).join('_');
}

function singularWord(word: string): string {
  if (word.length <= 3 || /(ss|us|is)$/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(sses|xes|zzes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function quoteNames(names: readonly string[]): string {
  return names.slice(0, MAX_TABLES_QUOTED).map((name) => name.slice(0, MAX_IDENTIFIER_LENGTH)).join(' and ');
}

/**
 * The same path with every character after `/ingest` replaced by another of its kind. Keeping the segment
 * count and each segment's format means an adapter that reads an id from the path still finds one. Different
 * shifts differ at every character, so a name derived from the path can't come out the same on two of them.
 * A percent escape is left alone, since a shifted one is usually invalid UTF-8 and would make decoding throw.
 */
function alternatePath(path: string, shift: number): string {
  const prefix = /^\/ingest(?=\/|$)/.exec(path)?.[0] ?? '';
  const altered = path.slice(prefix.length).replace(/%[0-9a-fA-F]{2}|[a-zA-Z0-9]/g, (char) => {
    if (char.length > 1) return char;
    const alphabet = PATH_ALPHABETS.find((letters) => letters.includes(char))!;
    return alphabet[(alphabet.indexOf(char) + shift) % alphabet.length]!;
  });
  return prefix + altered;
}

/**
 * Every table named in an output, sorted. This reads the output rather than the plan because the planner
 * skips a table with no rows, and a sample with an empty list would hide a computed child table. An altered
 * path's output hasn't been validated, so nothing about its structure is assumed.
 */
function tableNames(output: unknown): string[] {
  const names = new Set<string>();
  const visit = (object: unknown, defaultName?: string): void => {
    if (!isRecord(object)) return;
    const name = String(object.table ?? defaultName);
    names.add(name);
    if (!Array.isArray(object.rows)) return;
    for (const row of object.rows) {
      if (!isRecord(row) || !isRecord(row.children)) continue;
      for (const [key, child] of Object.entries(row.children)) visit(child, `${name}_${key}`);
    }
  };
  for (const object of Array.isArray(output) ? output : [output]) visit(object);
  return [...names].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The names in one set and not the other, since those are the ones to fix. */
function quoteTables(names: readonly string[], other: readonly string[]): string {
  const moved = names.filter((name) => !other.includes(name));
  if (moved.length === 0) return 'no other table';
  return moved.slice(0, MAX_TABLES_QUOTED).map((name) => name.slice(0, MAX_IDENTIFIER_LENGTH)).join(', ');
}

function plan(output: unknown, sample: GateSample, opaquePaths: readonly string[]) {
  return planWrite(output as AdapterResult, {
    eventId: sample.eventId,
    eventSeq: PLAN_SEQ,
    receivedAt: PLAN_RECEIVED_AT,
    opaquePaths,
  });
}

function missingAnywhere(
  changes: SchemaChange[],
  registries: ReadonlyMap<string, RegisteredColumns>,
): SchemaChange[] {
  if (registries.size === 0) return changes;
  const stores = [...registries.values()];
  return changes.filter((change) => stores.some((registered) => findMissingChanges([change], registered).length > 0));
}

function checkTypes(
  plan: WritePlan,
  registries: ReadonlyMap<string, RegisteredColumns>,
  seenAcrossSamples: RegisteredColumns,
): GateFailure[] {
  const conflicts = new Set<string>();
  for (const registered of registries.values()) {
    for (const conflict of findConflicts(plan.tables, registered)) conflicts.add(conflict);
  }
  const failures: GateFailure[] = [...conflicts].map((detail) => ({ code: 'type_conflict', detail }));

  for (const { table, columns } of plan.tables) {
    const seen = seenAcrossSamples.get(table) ?? new Map();
    seenAcrossSamples.set(table, seen);
    for (const [column, type] of Object.entries(columns)) {
      const existing = seen.get(column);
      if (existing && existing !== type) {
        failures.push({
          code: 'type_conflict',
          detail: `${table}.${column} is ${existing} on one sample and ${type} on another`,
        });
      } else {
        seen.set(column, type);
      }
    }
  }
  return failures;
}

/**
 * The sandbox turns integers above 2^53 into strings (§12), so a passed-through ID registers as
 * `number` and then quarantines as a `schema_conflict` once its value grows. Injected foreign keys are
 * always strings, so they never trip this.
 */
function checkNumericIds(plan: WritePlan): GateFailure[] {
  return plan.tables.flatMap(({ table, columns }) =>
    Object.entries(columns)
      .filter(([column, type]) => type === 'number' && column.endsWith('_id'))
      .map(([column]): GateFailure => ({
        code: 'numeric_id',
        detail: `${table}.${column} holds a number. Cast it to a string with String(...), because an ID can grow past ` +
          "what a number can hold, and a column's type can never change later.",
      })),
  );
}

/**
 * Catches a date-time written as text, at any depth in the output. A column's type never changes, so
 * once it registers as `string` the mistake is permanent.
 *
 * Two kinds of column are left alone. One already registered as `string` can't be declared `timestamp`
 * without a type conflict, so rejecting it would leave the shape no way to pass. A value equal to a
 * row's `id` is a reference, like an injected foreign key, which has to match that `id`.
 */
function checkUndeclaredTimestamps(
  plan: WritePlan,
  registries: ReadonlyMap<string, RegisteredColumns>,
): GateFailure[] {
  const ids = new Set(plan.tables.flatMap(({ rows }) => rows.map((row) => row.id)));
  const registeredAsString = (table: string, column: string) =>
    [...registries.values()].some((registered) => registered.get(table)?.get(column) === 'string');

  const failures: GateFailure[] = [];
  for (const { table, columns, rows } of plan.tables) {
    for (const [column, type] of Object.entries(columns)) {
      if (type !== 'string' || registeredAsString(table, column)) continue;
      const found = rows
        .map((row) => row[column])
        .find((value) => typeof value === 'string' && ISO_DATE_TIME.test(value) && !ids.has(value));
      if (found === undefined) continue;
      const quoted = JSON.stringify(found).slice(0, MAX_QUOTED_VALUE_LENGTH);
      failures.push({
        code: 'undeclared_timestamp',
        detail:
          `${table}.${column} holds the date-time ${quoted}, but is not declared as a timestamp. Add ` +
          `column_types: { ${column}: 'timestamp' } to that table, with values in ISO 8601 with a timezone. ` +
          "A column's type can never change later.",
      });
    }
  }
  return failures;
}

/** The planner has already checked each `id` that is present. This checks the output as returned. */
function checkDeleteRows(output: unknown): GateFailure[] {
  const objects = (Array.isArray(output) ? output : [output]) as { table: string; rows: Record<string, unknown>[] }[];
  const failures: GateFailure[] = [];
  let rowCount = 0;
  for (const { table, rows } of objects) {
    rows.forEach((row, index) => {
      rowCount += 1;
      if (row._deleted !== true) {
        failures.push({ code: 'delete_row', detail: `Row ${index} of table ${table} must set _deleted: true.` });
      }
      if (row.id === undefined) {
        failures.push({ code: 'delete_row', detail: `Row ${index} of table ${table} must set an id.` });
      }
    });
  }
  if (rowCount === 0) {
    failures.push({ code: 'delete_row', detail: 'A delete adapter must return at least one row, or nothing is deleted.' });
  }
  return failures;
}

function checkCarry(sample: GateSample, plan: WritePlan, opaquePaths: readonly string[]): GateFailure[] {
  const dropped = findDroppedValues(parseBodyLikeSandbox(sample.body), plan.tables, opaquePaths);
  const failures: GateFailure[] = dropped.slice(0, MAX_DROPPED_REPORTED).map(({ path, value, claimedElsewhere }) => ({
    code: 'dropped_field',
    detail: claimedElsewhere
      ? `${path} = ${value} is not carried. An equal value is in the output, but other fields account for it, ` +
        'so give this field its own column.'
      : `${path} = ${value} does not reach the output. Give it a column or child table, and keep the original ` +
        'when deriving a value from it.',
  }));
  if (dropped.length > MAX_DROPPED_REPORTED) {
    failures.push({ code: 'dropped_field', detail: `${dropped.length - MAX_DROPPED_REPORTED} more payload values are not carried.` });
  }
  return failures;
}

function checkEarlierColumns(earlier: WritePlan, current: WritePlan): GateFailure[] {
  const written = new Map(current.tables.map(({ table, columns }) => [table, columns]));
  const failures: GateFailure[] = [];
  for (const { table, columns } of earlier.tables) {
    for (const column of Object.keys(columns)) {
      if (written.get(table)?.[column] === undefined) {
        failures.push({
          code: 'dropped_column',
          detail: `The version being replaced writes ${table}.${column} for this payload, and this one does not. ` +
            'Keep writing every existing column.',
        });
      }
    }
  }
  return failures;
}

/** Names where two outputs first differ, so the LLM can find the source of the nondeterminism. */
function firstDifference(a: unknown, b: unknown, path: string): string {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return path;
  if (Array.isArray(a) !== Array.isArray(b)) return path;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!isDeepStrictEqual(left[key], right[key]) || Object.hasOwn(left, key) !== Object.hasOwn(right, key)) {
      return firstDifference(left[key], right[key], `${path}.${key}`);
    }
  }
  return path;
}

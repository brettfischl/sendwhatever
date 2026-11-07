// The validation gate (PRD §12.1), the main protection against a bad adapter, since adapters can go
// live with no human review. This file has no database access: `store.ts` loads what it needs, and the
// generator can call `runGate` directly. Failures are collected rather than stopping at the first, so
// the LLM can fix them all in one retry. Their text quotes payload values, which are data.
import { isDeepStrictEqual } from 'node:util';
import type { AdapterRequest, AdapterResult, SchemaChange } from '../contracts/index.js';
import { OpaquePathError, parseOpaquePath } from '../fingerprint/index.js';
import { planWrite, type WritePlan } from '../planner/index.js';
import { findConflicts, findMissingChanges, type RegisteredColumns } from '../planner/registry.js';
import { runAdapter, type SandboxFailureKind, type SandboxLimits } from '../sandbox/index.js';
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
  /** A string column holds an ISO 8601 date-time, and isn't declared `timestamp`. */
  | 'undeclared_timestamp'
  /** `op = delete`, and a top-level row lacks `_deleted: true` or an `id`, or there are no rows. */
  | 'delete_row'
  | 'dropped_field'
  /** A column the version being replaced wrote for this sample is no longer written. */
  | 'dropped_column';

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
  const run = (code: string) =>
    (options.run ?? runAdapter)({ code, body: sample.body, request: sample.request }, options.limits);
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
    ...checkUndeclaredTimestamps(planned.plan, registries),
    ...(adapter.op === 'delete' ? checkDeleteRows(first.output) : []),
    ...checkCarry(sample, planned.plan, adapter.opaquePaths),
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

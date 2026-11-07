// The field-carry check (PRD §12.1): every value in the payload must reach the planned rows, so an
// adapter can't pass while silently losing data.
//
// Output is compared with the plan rather than the adapter's raw return value, because the plan is
// what gets written. Rows that share an `id` have already merged there, so an adapter that gives every
// row the same `id` loses values and fails here.
//
// Matching counts occurrences, and each output value can account for only one payload value. In
// `{ a: "x", b: "x" }`, an output holding one "x" has dropped a field, even though "x" is present.
// Values never match by substring, so `full_name: "Ada Lovelace"` doesn't carry `first: "Ada"`.
//
// What this can't see: if a dropped field's value equals a new derived value, the counts balance. A
// rename looks the same. Several samples with different values make that coincidence unlikely.
import type { TableRows } from '../contracts/index.js';
import { parseOpaquePath } from '../fingerprint/index.js';

export interface DroppedValue {
  /** Where the value sits in the payload, such as `$.orders[].sku`. */
  path: string;
  /** The value, shortened for error text. Payload content, so it is data and never instructions. */
  value: string;
  /** The output holds an equal value, but other payload fields already account for it. */
  claimedElsewhere: boolean;
}

type Scalar = string | number | boolean;

interface PayloadValue {
  path: string;
  value: Scalar;
  /** A `true` flag such as `deleted`, which may become `_deleted` on the row. */
  deleteFlag: boolean;
}

interface OutputValue {
  claimed: boolean;
}

const MAX_VALUE_LENGTH = 80;
/** Paths are built from client-controlled keys, so they end up in error text and LLM retries. */
const MAX_PATH_LENGTH = 200;
const ARRAY = '[]';

/** Decimal text with no leading zeros, so "007" stays text: casting it to 7 would lose data. */
const PLAIN_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const DELETE_FLAG_KEY = /^_?(is_?)?(deleted|removed|destroyed)$/i;
/**
 * A time followed by a zone, which may be named, like PST. It requires the time, so the end of
 * `2026-01-02` isn't read as an offset, and it leaves out AM and PM, which aren't zones.
 */
const TIME_WITH_ZONE = /\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(?!(?:AM|PM)$)(Z|[A-Z]{2,4}|[+-]\d{2}(:?\d{2})?)$/i;

/**
 * Parses a body the way the sandbox does (src/sandbox/guest.js), so the payload values here are the
 * ones the adapter saw. An integer too large for a number stays a string, instead of being rounded
 * and then failing to match the adapter's correct output.
 */
export function parseBodyLikeSandbox(body: string | null): unknown {
  if (body === null || body === '') return null;
  const keepLargeIntegers = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
      ? context?.source
      : value;
  return JSON.parse(body, keepLargeIntegers as Parameters<typeof JSON.parse>[1]);
}

/**
 * The form two values share if one is a lossless cast of the other: `5` and `"5"`, `19.9` and
 * `"19.90"`, `true` and `"true"`. Text a double can't hold exactly stays distinct from its rounded
 * number, because the rounded number prints differently.
 */
function castKey(value: Scalar): string {
  if (typeof value !== 'string') return String(value);
  if (!PLAIN_DECIMAL.test(value)) return value;
  const trimmed = value.includes('.') ? value.replace(/\.?0+$/, '') : value;
  return trimmed === '-0' ? '0' : trimmed;
}

/**
 * The instants a payload value could mean, for comparing it with a declared `timestamp` column: PRD
 * §12.1 tells adapters to normalize dates to ISO 8601, which changes their text. A value with no zone
 * is read as UTC, so the result doesn't depend on the host's timezone.
 */
function candidateInstants(value: Scalar): number[] {
  if (typeof value === 'boolean') return [];
  // A Date holds whole milliseconds, so fractional epoch seconds lose any finer precision in the cast.
  if (typeof value === 'number') return [Math.trunc(value * 1000), value];
  if (/^\d{10}$|^\d{13}$/.test(value)) return candidateInstants(Number(value));
  if (value.length < 8 || !/\d/.test(value)) return [];
  const instant = TIME_WITH_ZONE.test(value)
    ? parseInstant(value)
    : Date.parse(/T\d/.test(value) ? `${value}Z` : `${value} UTC`);
  return Number.isNaN(instant) ? [] : [instant];
}

/** Date.parse rejects an hours-only offset, which a timestamp column allows (§8). */
function parseInstant(value: string): number {
  return Date.parse(value.replace(/([+-]\d{2})$/, '$1:00'));
}

/** Identical JSON in any key order. Nulls are left out, because they aren't values here or in the shape. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.filter((item) => item !== null).map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isRecordWithId(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { id?: unknown }).id != null;
}

function displayPath(path: readonly string[]): string {
  return path.reduce((text, segment) => (segment === ARRAY ? `${text}[]` : `${text}.${segment}`), '$');
}

/**
 * Lists the values that must be carried.
 *
 * - `null` isn't a value: the fingerprint ignores it, and §12.1 says to leave out a field that doesn't
 *   clear anything.
 * - Keys are renamed freely, so they aren't values, except inside an opaque path, where the keys vary
 *   and are themselves the data (§7.1).
 * - `deleted: false` needs nothing, because a row with no `_deleted` already says so.
 * - An identical object or array element repeated at the same path counts once. A customer embedded in
 *   every order merges into one row (§8), and that isn't data loss. The cost is that keeping one of two
 *   wholly identical list items also passes.
 * - A single object with an `id` that is identical to an item of a list elsewhere counts once, so a featured
 *   record like Shopify's `image`, repeating an item of `images`, can be written once in that list's table
 *   (§12.1). The cost is that the reference to the featured item, such as `featured_image_id`, isn't
 *   required. Two single objects, such as equal `created_by` and `updated_by`, still count separately.
 */
function collectPayloadValues(data: unknown, opaquePaths: readonly string[]): PayloadValue[] {
  const opaque = opaquePaths.map((path) => parseOpaquePath(path));
  const inOpaque = (path: readonly string[]) =>
    opaque.some((declared) => declared.length <= path.length && declared.every((part, i) => part === path[i]));

  const found: PayloadValue[] = [];
  const seen = new Set<string>();
  const firstVisit = (path: readonly string[], value: unknown) => {
    const content = stableStringify(value);
    const key = `${JSON.stringify(path)}:${content}`;
    if (seen.has(key)) return false;
    if (isRecordWithId(value)) {
      const listed = path.at(-1) === ARRAY;
      if (seen.has(`${listed ? 'single' : 'listed'}:${content}`)) return false;
      seen.add(`${listed ? 'listed' : 'single'}:${content}`);
    }
    seen.add(key);
    return true;
  };

  const visit = (value: unknown, path: string[], key: string | undefined): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      const elementPath = [...path, ARRAY];
      for (const element of value) {
        if (firstVisit(elementPath, element)) visit(element, elementPath, undefined);
      }
    } else if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        const childPath = [...path, childKey];
        if (child === null) continue;
        if (inOpaque(path)) found.push({ path: `${displayPath(path)} key`, value: childKey, deleteFlag: false });
        if (typeof child === 'object' && !firstVisit(childPath, child)) continue;
        visit(child, childPath, childKey);
      }
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const isFlag = typeof value === 'boolean' && key !== undefined && DELETE_FLAG_KEY.test(key) && !inOpaque(path);
      if (isFlag && !value) return;
      found.push({ path: displayPath(path), value, deleteFlag: isFlag });
    }
  };

  visit(data, [], undefined);
  return found;
}

function append<K>(index: Map<K, OutputValue[]>, key: K, entry: OutputValue): void {
  const entries = index.get(key);
  if (entries) entries.push(entry);
  else index.set(key, [entry]);
}

/** Indexes every value in the plan, including inside json columns, whose keys count too. */
function indexOutput(tables: readonly TableRows[]) {
  const byCast = new Map<string, OutputValue[]>();
  const byInstant = new Map<number, OutputValue[]>();
  let deletedRows = 0;

  const add = (value: Scalar): OutputValue => {
    const entry: OutputValue = { claimed: false };
    append(byCast, castKey(value), entry);
    return entry;
  };
  const addJson = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach(addJson);
    else if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        add(key);
        addJson(item);
      }
    } else add(value as Scalar);
  };

  for (const { columns, rows } of tables) {
    for (const row of rows) {
      if (row._deleted_at !== undefined) deletedRows += 1;
      for (const [column, value] of Object.entries(row)) {
        if (column === '_event_seq' || column === '_deleted_at') continue;
        if (columns[column] === 'timestamp' && typeof value === 'string') {
          append(byInstant, parseInstant(value), add(value));
        } else {
          addJson(value);
        }
      }
    }
  }
  return { byCast, byInstant, deletedRows };
}

function claim(entries: OutputValue[] | undefined): boolean {
  // Popping keeps this linear. A timestamp's entry is in two indexes, so it can already be claimed.
  while (entries && entries.length > 0) {
    const entry = entries.pop()!;
    if (!entry.claimed) {
      entry.claimed = true;
      return true;
    }
  }
  return false;
}

function shorten(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

/** Returns each payload value with nothing left in the output to account for it. */
export function findDroppedValues(
  data: unknown,
  tables: readonly TableRows[],
  opaquePaths: readonly string[],
): DroppedValue[] {
  const output = indexOutput(tables);
  const payload = collectPayloadValues(data, opaquePaths);
  const fields = payload.filter((item) => !item.deleteFlag);

  // Exact and cast matches go first, so a timestamp normalization can't take a value another field
  // matches exactly. Flags go last, so `deleted: true` can't take `active: true`'s column.
  const unmatched = fields.filter((item) => !claim(output.byCast.get(castKey(item.value))));
  const dropped = unmatched.filter(
    (item) => !candidateInstants(item.value).some((instant) => claim(output.byInstant.get(instant))),
  );

  let deletedRows = output.deletedRows;
  for (const flag of payload.filter((item) => item.deleteFlag)) {
    if (claim(output.byCast.get(castKey(flag.value)))) continue;
    if (deletedRows > 0) deletedRows -= 1;
    else dropped.push(flag);
  }

  return dropped.map(({ path, value }) => {
    return {
      path: shorten(path, MAX_PATH_LENGTH),
      value: shorten(JSON.stringify(value), MAX_VALUE_LENGTH),
      claimedElsewhere: output.byCast.has(castKey(value)),
    };
  });
}

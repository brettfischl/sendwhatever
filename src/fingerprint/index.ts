import { createHash } from 'node:crypto';

/**
 * Structural fingerprint of a request body (PRD §7): a hash of its shape, ignoring values.
 * It is the lookup key for which adapter handles an event, and groups quarantined events by shape.
 */

/** Bump if the shape rules change, since every stored fingerprint would change with them. */
export const FINGERPRINT_VERSION = 1;

/** Hex characters kept from the SHA-256 digest. */
export const FINGERPRINT_LENGTH = 16;

/** Deepest container nesting accepted. `[]` is 1 level, `[[]]` is 2. */
export const MAX_DEPTH = 256;

/** Thrown when a body nests deeper than MAX_DEPTH. `/ingest` quarantines it as malformed. */
export class FingerprintDepthError extends Error {
  constructor() {
    super(`Body nests deeper than ${MAX_DEPTH} levels`);
    this.name = 'FingerprintDepthError';
  }
}

/** Thrown for an opaque path that isn't valid syntax, or that would collapse the whole body. */
export class OpaquePathError extends Error {
  constructor(path: string, reason: string) {
    super(`Invalid opaque path ${JSON.stringify(path)}: ${reason}`);
    this.name = 'OpaquePathError';
  }
}

export interface ShapeOptions {
  /**
   * Opaque paths (PRD §7.1), such as `metadata` or `orders[].metadata`. The value at each path
   * is replaced by the marker "opaque", so its contents don't affect the shape. Field names are
   * joined with `.`, and `[]` means "any element of this array". A field whose name contains
   * `.`, `[`, or `]` can't be named. Omit for an event's full shape.
   */
  opaquePaths?: readonly string[];
}

/** Where a value sits in the body: object keys, with '[]' standing for "any array element". */
type Path = readonly string[];

const ARRAY = '[]';
const OPAQUE_SHAPE = '"opaque"';

/**
 * The canonical shape string, e.g. `{"email":"string","orders":[{"sku":"string"}]}`.
 * A missing body (undefined) or null has the shape `null`.
 */
export function shapeOf(body: unknown, options: ShapeOptions = {}): string {
  const opaque = new Set((options.opaquePaths ?? []).map((path) => pathKey(parseOpaquePath(path))));
  return shapeAt(body, [], opaque) ?? 'null';
}

/** The 16-character hex fingerprint of a body. */
export function fingerprint(body: unknown, options: ShapeOptions = {}): string {
  return fingerprintOfShape(shapeOf(body, options));
}

/**
 * Splits an opaque path into segments: `orders[].metadata` → `['orders', '[]', 'metadata']`.
 * A leading `[]` addresses elements of a top-level array, as in `[].metadata`. The path must name
 * at least one field, so the body root and a root array's elements can't be collapsed.
 */
export function parseOpaquePath(path: string): Path {
  const segments: string[] = [];
  const parts = path.split('.');
  parts.forEach((part, index) => {
    const match = /^([^.[\]]*)((?:\[\])*)$/.exec(part);
    if (!match) throw new OpaquePathError(path, 'use field names joined by "." with optional "[]"');
    const [, name = '', brackets = ''] = match;
    if (name === '' && !(index === 0 && brackets !== '')) {
      throw new OpaquePathError(path, 'empty field name');
    }
    if (name !== '') segments.push(name);
    for (let i = 0; i < brackets.length / 2; i++) segments.push(ARRAY);
  });
  if (!segments.some((segment) => segment !== ARRAY)) {
    throw new OpaquePathError(path, 'must name at least one field');
  }
  return segments;
}

/** A Set key for a path. JSON keeps segments apart even if a field name contains "." */
function pathKey(path: Path): string {
  return JSON.stringify(path);
}

/** The fingerprint of a shape string already produced by `shapeOf`. */
export function fingerprintOfShape(shape: string): string {
  return createHash('sha256').update(shape, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Returns the serialized shape of `value`, or undefined if it should be skipped.
 *
 * The string is built directly rather than by calling JSON.stringify on a shape object. The
 * output is the same, but JS objects list integer-like keys ("2", "10") first whatever order
 * they were added in, which would break the sort, and array elements need their serialized form
 * for dedupe and sorting anyway.
 */
function shapeAt(value: unknown, path: Path, opaque: ReadonlySet<string>): string | undefined {
  // Null is skipped before the opaque check, so `{"metadata": null}` still matches `{}`.
  if (value === null || value === undefined) return undefined;
  if (opaque.size > 0 && opaque.has(pathKey(path))) return OPAQUE_SHAPE;
  switch (typeof value) {
    case 'string':
      return '"string"';
    // JSON.parse turns huge integers into (imprecise) numbers, so they fingerprint as "number".
    case 'number':
      return '"number"';
    case 'boolean':
      return '"boolean"';
    case 'object':
      if (path.length >= MAX_DEPTH) throw new FingerprintDepthError();
      return Array.isArray(value)
        ? arrayShape(value, path, opaque)
        : objectShape(value, path, opaque);
    default:
      // Anything JSON.parse can't produce (undefined, functions, ...) is skipped like null.
      return undefined;
  }
}

/** Null-valued keys are skipped, so a nullable field doesn't multiply shapes. */
function objectShape(value: object, path: Path, opaque: ReadonlySet<string>): string {
  const fields: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const shape = shapeAt((value as Record<string, unknown>)[key], [...path, key], opaque);
    if (shape !== undefined) fields.push(`${JSON.stringify(key)}:${shape}`);
  }
  return `{${fields.join(',')}}`;
}

/** Lists each distinct element shape once, sorted, so length and order don't matter. Nulls are skipped. */
function arrayShape(value: readonly unknown[], path: Path, opaque: ReadonlySet<string>): string {
  const elementPath = [...path, ARRAY];
  const shapes = new Set<string>();
  for (const element of value) {
    const shape = shapeAt(element, elementPath, opaque);
    if (shape !== undefined) shapes.add(shape);
  }
  return `[${[...shapes].sort(compareCodeUnits).join(',')}]`;
}

/** UTF-16 code-unit order, never localeCompare, so results match on every machine. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

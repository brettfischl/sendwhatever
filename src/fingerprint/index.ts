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

/**
 * Where a value sits in the body: object keys, with '[]' standing for "any array element".
 * Unused today; it is threaded through so opaque paths (PRD §7.1) can be matched later.
 */
type Path = readonly string[];

/**
 * The canonical shape string, e.g. `{"email":"string","orders":[{"sku":"string"}]}`.
 * A missing body (undefined) or null has the shape `null`.
 */
export function shapeOf(body: unknown): string {
  return shapeAt(body, []) ?? 'null';
}

/** The 16-character hex fingerprint of a body. */
export function fingerprint(body: unknown): string {
  return fingerprintOfShape(shapeOf(body));
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
function shapeAt(value: unknown, path: Path): string | undefined {
  switch (typeof value) {
    case 'string':
      return '"string"';
    // JSON.parse turns huge integers into (imprecise) numbers, so they fingerprint as "number".
    case 'number':
      return '"number"';
    case 'boolean':
      return '"boolean"';
    case 'object':
      if (value === null) return undefined;
      if (path.length >= MAX_DEPTH) throw new FingerprintDepthError();
      return Array.isArray(value) ? arrayShape(value, path) : objectShape(value, path);
    default:
      // Anything JSON.parse can't produce (undefined, functions, ...) is skipped like null.
      return undefined;
  }
}

/** Null-valued keys are skipped, so a nullable field doesn't multiply shapes. */
function objectShape(value: object, path: Path): string {
  const fields: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const shape = shapeAt((value as Record<string, unknown>)[key], [...path, key]);
    if (shape !== undefined) fields.push(`${JSON.stringify(key)}:${shape}`);
  }
  return `{${fields.join(',')}}`;
}

/** Lists each distinct element shape once, sorted, so length and order don't matter. Nulls are skipped. */
function arrayShape(value: readonly unknown[], path: Path): string {
  const elementPath = [...path, '[]'];
  const shapes = new Set<string>();
  for (const element of value) {
    const shape = shapeAt(element, elementPath);
    if (shape !== undefined) shapes.add(shape);
  }
  return `[${[...shapes].sort(compareCodeUnits).join(',')}]`;
}

/** UTF-16 code-unit order, never localeCompare, so results match on every machine. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

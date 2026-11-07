// The subset/superset rule for reusing an adapter on a new shape (PRD §12.1 step 2). The gate alone is too
// weak here: an adapter with a loop that copies any key passes on a shape it has nothing to do with.
import { shapeOf } from '../fingerprint/index.js';

/** Every leaf of a shape as `path:type`. Array elements share a path, so a list's variations are merged. */
function leaves(shape: unknown, path: string, into: Set<string>): Set<string> {
  if (Array.isArray(shape)) {
    if (shape.length === 0) into.add(`${path}:empty_array`);
    for (const element of shape) leaves(element, `${path}[]`, into);
  } else if (typeof shape === 'object' && shape !== null) {
    const entries = Object.entries(shape);
    if (entries.length === 0) into.add(`${path}:empty_object`);
    for (const [key, value] of entries) leaves(value, `${path}.${key}`, into);
  } else if (shape !== null) {
    into.add(`${path}:${String(shape)}`);
  }
  return into;
}

function leavesOf(body: unknown, opaquePaths: readonly string[]): Set<string> {
  return leaves(JSON.parse(shapeOf(body, { opaquePaths })), '', new Set());
}

function includesAll(outer: ReadonlySet<string>, inner: ReadonlySet<string>): boolean {
  return [...inner].every((leaf) => outer.has(leaf));
}

/**
 * Whether a new body overlaps what an adapter was validated on: every field of it has been seen across
 * those shapes, or it contains all of one of them. Types count, so `{ id: 1 }` doesn't overlap
 * `{ id: "a" }`. A shape with no fields overlaps nothing, since it would be a subset of everything.
 */
export function shapesOverlap(body: unknown, validatedBodies: readonly unknown[], opaquePaths: readonly string[]): boolean {
  const candidate = leavesOf(body, opaquePaths);
  if (candidate.size === 0) return false;
  const validated = validatedBodies.map((validatedBody) => leavesOf(validatedBody, opaquePaths)).filter(({ size }) => size > 0);
  if (validated.length === 0) return false;
  return includesAll(new Set(validated.flatMap((set) => [...set])), candidate) || validated.some((set) => includesAll(candidate, set));
}

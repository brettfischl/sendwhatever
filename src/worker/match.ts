// Which active adapter handles an event (PRD §7.1). Replays and rebuilds use the same matching.
import type pg from 'pg';
import { fingerprint } from '../fingerprint/index.js';

export interface EventShape {
  accountId: string;
  source: string;
  op: string;
  /** The full fingerprint from `events`. */
  fingerprint: string | null;
  /** The raw body text. */
  body: string;
}

export interface MatchedAdapter {
  id: string;
  code: string;
  opaquePaths: string[];
}

const COLUMNS = 'a.id, a.code, a.opaque_paths AS "opaquePaths", a.fingerprint';

/**
 * An exact match on the full fingerprint comes first, on the adapter's own fingerprint or one it has
 * been validated against. Then each active adapter's opaque paths are collapsed out of the event.
 * Where several match, the fewest opaque paths wins, then the newest.
 */
export async function findAdapter(db: pg.Pool, event: EventShape): Promise<MatchedAdapter | null> {
  const key = [event.accountId, event.source, event.op];

  const exact = await db.query<MatchedAdapter>(
    `SELECT ${COLUMNS} FROM adapters a
     WHERE a.account_id = $1 AND a.source = $2 AND a.op = $3 AND a.active
       AND (a.fingerprint = $4 OR EXISTS (
         SELECT 1 FROM adapter_fingerprints f WHERE f.adapter_id = a.id AND f.fingerprint = $4))
     ORDER BY a.fingerprint = $4 DESC, cardinality(a.opaque_paths), a.created_at DESC, a.id DESC
     LIMIT 1`,
    [...key, event.fingerprint],
  );
  if (exact.rows[0]) return exact.rows[0];

  const opaque = await db.query<MatchedAdapter & { fingerprint: string }>(
    `SELECT ${COLUMNS} FROM adapters a
     WHERE a.account_id = $1 AND a.source = $2 AND a.op = $3 AND a.active AND cardinality(a.opaque_paths) > 0
     ORDER BY cardinality(a.opaque_paths), a.created_at DESC, a.id DESC`,
    key,
  );
  if (opaque.rows.length === 0) return null;

  const collapse = collapser(event.body);
  return opaque.rows.find((adapter) => collapse(adapter.opaquePaths) === adapter.fingerprint) ?? null;
}

/**
 * Returns the body's fingerprint for a set of opaque paths, working each distinct set out once.
 *
 * A body or path that can't be fingerprinted gives `undefined`, which matches nothing. These are pure
 * functions, so a retry would fail the same way, and one adapter's bad path mustn't hold up the events
 * that other adapters can handle.
 */
function collapser(rawBody: string): (paths: readonly string[]) => string | undefined {
  const known = new Map<string, string | undefined>();
  let body: unknown;
  let parsed = false;
  return (paths) => {
    const key = JSON.stringify([...paths].sort());
    if (known.has(key)) return known.get(key);
    let result: string | undefined;
    try {
      if (!parsed) {
        body = rawBody === '' ? undefined : JSON.parse(rawBody);
        parsed = true;
      }
      result = fingerprint(body, { opaquePaths: paths });
    } catch {
      result = undefined;
    }
    known.set(key, result);
    return result;
  };
}

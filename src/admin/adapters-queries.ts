import type pg from 'pg';

/** Read-only queries for the admin Adapters pages. Every query is scoped by account_id. Attempt `detail` is codes only. */

export type ShapeStatus = 'active' | 'awaiting_approval' | 'failing' | 'generating' | 'draft';
export type VersionStatus = 'active' | 'awaiting_approval' | 'superseded' | 'draft';

export interface ShapeKey {
  source: string;
  op: string;
  fingerprint: string;
}

export interface ShapeRow extends ShapeKey {
  status: ShapeStatus;
  /** The active version, or the latest when none is active. */
  currentId: string;
  currentVersion: number;
  versionCount: number;
  lastAttemptStatus: string | null;
  lastAttemptAt: Date | null;
  eventCount: number;
}

// $2..$4 optionally narrow to one shape (all three null for the list).
const SHAPES_SQL = `
WITH shapes AS (
  SELECT source, op, fingerprint,
         count(*)::int AS versions,
         bool_or(active) AS has_active,
         bool_or(validated_at IS NOT NULL AND NOT active AND superseded_at IS NULL) AS awaiting
    FROM adapters
   WHERE account_id = $1
     AND ($2::text IS NULL OR (source = $2 AND op = $3 AND fingerprint = $4))
   GROUP BY source, op, fingerprint
)
SELECT s.source, s.op, s.fingerprint, s.versions, s.has_active, s.awaiting,
       cur.id AS current_id, cur.version AS current_version,
       la.status AS last_status, la.at AS last_at,
       EXISTS (
         SELECT 1 FROM adapter_attempts t
          WHERE t.account_id = $1 AND t.source = s.source AND t.op = s.op
            AND t.fingerprint = s.fingerprint AND t.status = 'running'
       ) AS running,
       ev.n AS events
  FROM shapes s
  JOIN LATERAL (
    SELECT a.id, a.version FROM adapters a
     WHERE a.account_id = $1 AND a.source = s.source AND a.op = s.op AND a.fingerprint = s.fingerprint
     ORDER BY a.active DESC, a.version DESC LIMIT 1
  ) cur ON true
  LEFT JOIN LATERAL (
    SELECT t.status, COALESCE(t.finished_at, t.started_at) AS at FROM adapter_attempts t
     WHERE t.account_id = $1 AND t.source = s.source AND t.op = s.op AND t.fingerprint = s.fingerprint
     ORDER BY t.started_at DESC LIMIT 1
  ) la ON true
  JOIN LATERAL (
    SELECT count(*)::int AS n FROM events e
     WHERE e.account_id = $1 AND e.source = s.source AND e.op = s.op AND e.fingerprint = s.fingerprint
  ) ev ON true
 ORDER BY s.source, s.op, s.fingerprint`;

interface ShapeSqlRow extends ShapeKey {
  versions: number;
  has_active: boolean;
  awaiting: boolean;
  current_id: string;
  current_version: number;
  last_status: string | null;
  last_at: Date | null;
  running: boolean;
  events: number;
}

function shapeStatus(r: ShapeSqlRow): ShapeStatus {
  if (r.has_active) return 'active';
  if (r.awaiting) return 'awaiting_approval';
  if (r.running) return 'generating';
  if (r.last_status === 'failed') return 'failing';
  return 'draft';
}

async function shapes(db: pg.Pool, accountId: string, shape: ShapeKey | null): Promise<ShapeRow[]> {
  const { rows } = await db.query<ShapeSqlRow>(SHAPES_SQL, [
    accountId,
    shape?.source ?? null,
    shape?.op ?? null,
    shape?.fingerprint ?? null,
  ]);
  return rows.map((r) => ({
    source: r.source,
    op: r.op,
    fingerprint: r.fingerprint,
    status: shapeStatus(r),
    currentId: r.current_id,
    currentVersion: r.current_version,
    versionCount: r.versions,
    lastAttemptStatus: r.last_status,
    lastAttemptAt: r.last_at,
    eventCount: r.events,
  }));
}

/** One row per shape that has at least one adapter version. */
export const listShapes = (db: pg.Pool, accountId: string) => shapes(db, accountId, null);

export interface AdapterVersion {
  id: string;
  version: number;
  status: VersionStatus;
  createdAt: Date;
}

export interface Attempt {
  status: string;
  detail: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface AdapterDetail extends ShapeKey {
  id: string;
  version: number;
  code: string;
  active: boolean;
  opaquePaths: string[];
  validatedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  shapeStatus: ShapeStatus;
  versions: AdapterVersion[];
  attempts: Attempt[];
  extraFingerprints: { fingerprint: string; createdAt: Date }[];
}

export const ATTEMPT_LIMIT = 20;

export const versionStatus = (v: {
  active: boolean;
  validatedAt: Date | null;
  supersededAt: Date | null;
}): VersionStatus =>
  v.active ? 'active' : v.supersededAt ? 'superseded' : v.validatedAt ? 'awaiting_approval' : 'draft';

/** The adapter with this id, if it belongs to the account, with its shape's versions and attempts. */
export async function getAdapterDetail(
  db: pg.Pool,
  accountId: string,
  adapterId: string,
): Promise<AdapterDetail | null> {
  const found = await db.query<{
    id: string;
    source: string;
    op: string;
    fingerprint: string;
    version: number;
    code: string;
    active: boolean;
    opaque_paths: string[];
    validated_at: Date | null;
    superseded_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, source, op, fingerprint, version, code, active, opaque_paths, validated_at, superseded_at, created_at
       FROM adapters WHERE account_id = $1 AND id = $2`,
    [accountId, adapterId],
  );
  const a = found.rows[0];
  if (!a) return null;
  const shape = [accountId, a.source, a.op, a.fingerprint];

  const [versions, attempts, extras, status] = await Promise.all([
    db.query<{
      id: string;
      version: number;
      active: boolean;
      validated_at: Date | null;
      superseded_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, version, active, validated_at, superseded_at, created_at FROM adapters
        WHERE account_id = $1 AND source = $2 AND op = $3 AND fingerprint = $4 ORDER BY version DESC`,
      shape,
    ),
    db.query<{ status: string; detail: string | null; started_at: Date; finished_at: Date | null }>(
      `SELECT status, detail, started_at, finished_at FROM adapter_attempts
        WHERE account_id = $1 AND source = $2 AND op = $3 AND fingerprint = $4
        ORDER BY started_at DESC LIMIT ${ATTEMPT_LIMIT}`,
      shape,
    ),
    db.query<{ fingerprint: string; created_at: Date }>(
      `SELECT f.fingerprint, f.created_at FROM adapter_fingerprints f
         JOIN adapters x ON x.id = f.adapter_id
        WHERE x.account_id = $1 AND f.adapter_id = $2 ORDER BY f.created_at, f.fingerprint`,
      [accountId, adapterId],
    ),
    shapes(db, accountId, { source: a.source, op: a.op, fingerprint: a.fingerprint }),
  ]);

  return {
    id: a.id,
    source: a.source,
    op: a.op,
    fingerprint: a.fingerprint,
    version: a.version,
    code: a.code,
    active: a.active,
    opaquePaths: a.opaque_paths,
    validatedAt: a.validated_at,
    supersededAt: a.superseded_at,
    createdAt: a.created_at,
    shapeStatus: status[0]?.status ?? 'draft',
    versions: versions.rows.map((v) => ({
      id: v.id,
      version: v.version,
      status: versionStatus({ active: v.active, validatedAt: v.validated_at, supersededAt: v.superseded_at }),
      createdAt: v.created_at,
    })),
    attempts: attempts.rows.map((t) => ({
      status: t.status,
      detail: t.detail,
      startedAt: t.started_at,
      finishedAt: t.finished_at,
    })),
    extraFingerprints: extras.rows.map((f) => ({ fingerprint: f.fingerprint, createdAt: f.created_at })),
  };
}

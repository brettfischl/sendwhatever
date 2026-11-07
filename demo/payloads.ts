/**
 * Everything the site sends to /ingest is built here, as plain JSON a webinar product might
 * really emit. There is deliberately no { type, data } envelope (PRD §6). Each builder returns
 * the whole request, so the tests can check what goes over the wire without a server.
 */

export type SessionStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';

export interface Speaker {
  id: string;
  name: string;
  title?: string;
  company?: string;
}

export interface Sponsor {
  id: string;
  name: string;
}

export interface AgendaItem {
  position: number;
  title: string;
  starts_at: string;
  duration_minutes: number;
  speaker_id?: string;
}

export interface WebinarSession {
  id: string;
  title: string;
  description: string;
  status: SessionStatus;
  timezone: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  organizer: { name: string; email: string };
  speakers: Speaker[];
  agenda: AgendaItem[];
  tags: string[];
  created_at: string;
  started_at?: string;
  ended_at?: string;
  cancelled_at?: string;
}

export interface Registration {
  id: string;
  session_id: string;
  email: string;
  first_name: string;
  last_name: string;
  company?: string;
  job_title?: string;
  marketing_consent: boolean;
  status: 'registered' | 'cancelled';
  registered_at: string;
  attendance_status: 'not_joined' | 'watching' | 'left';
  join_count: number;
  watch_seconds: number;
  last_joined_at?: string;
}

export interface Comment {
  id: string;
  registration_id: string;
  author: { name: string; company?: string };
  body: string;
  posted_at: string;
  video_offset_seconds: number;
  deleted: boolean;
  deleted_at: string | null;
}

export interface IngestRequest {
  /** What happened, for the request log. Never sent. */
  label: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  /** Appended to the ingest URL, such as "speakers". Empty means plain /ingest. */
  path: string;
  body: object;
}

/** The statuses a session can move to, and the field that records when it did. */
export type SessionTransition = Exclude<SessionStatus, 'scheduled'>;
export const statusTimestampKey = {
  live: 'started_at',
  ended: 'ended_at',
  cancelled: 'cancelled_at',
} as const satisfies Record<SessionTransition, keyof WebinarSession>;

/** A new session: nested speakers, agenda, and tags. */
export function sessionCreated(session: WebinarSession): IngestRequest {
  return {
    label: `Create session "${session.title}"`,
    method: 'POST',
    path: '',
    body: session,
  };
}

/** A partial update: only the id and what changed. */
export function sessionStatusChanged(
  session: WebinarSession,
  status: SessionTransition,
  at: string,
): IngestRequest {
  return {
    label: `Session status → ${status}`,
    method: 'PATCH',
    path: '',
    body: { id: session.id, status, [statusTimestampKey[status]]: at },
  };
}

/** A registration with the session embedded, so one event writes to several tables. */
export function registrationCreated(
  registration: Registration,
  session: WebinarSession,
): IngestRequest {
  const { id, email, first_name, last_name, company, job_title, status, registered_at } =
    registration;
  return {
    label: `Register ${first_name} ${last_name}`,
    method: 'POST',
    path: '',
    body: {
      id,
      email,
      first_name,
      last_name,
      ...(company ? { company } : {}),
      ...(job_title ? { job_title } : {}),
      status,
      registered_at,
      consent: { marketing: registration.marketing_consent },
      session,
    },
  };
}

/** A partial update to a registration: the viewer started watching. */
export function attendanceJoined(registration: Registration, at: string): IngestRequest {
  return {
    label: `${registration.first_name} joined`,
    method: 'PATCH',
    path: '',
    body: {
      id: registration.id,
      attendance_status: 'watching',
      last_joined_at: at,
      join_count: registration.join_count,
    },
  };
}

/** A partial update to a registration: the viewer stopped watching. */
export function attendanceLeft(registration: Registration, at: string): IngestRequest {
  return {
    label: `${registration.first_name} left`,
    method: 'PATCH',
    path: '',
    body: {
      id: registration.id,
      attendance_status: 'left',
      left_at: at,
      watch_seconds: registration.watch_seconds,
    },
  };
}

/** The record is gone. The id is in the body, which PRD §6 allows on a DELETE. */
export function registrationCancelled(
  registration: Registration,
  at: string,
  reason: string,
): IngestRequest {
  return {
    label: `Cancel registration for ${registration.first_name} ${registration.last_name}`,
    method: 'DELETE',
    path: '',
    body: {
      id: registration.id,
      session_id: registration.session_id,
      email: registration.email,
      reason,
      cancelled_at: at,
    },
  };
}

/**
 * The append-only comment stream, flushed in batches as live chat does. A removed comment is
 * sent again with `deleted: true` on the item, so only the per-item flag signals a delete.
 */
export function commentBatch(sessionId: string, comments: Comment[], sentAt: string): IngestRequest {
  const removed = comments.filter((comment) => comment.deleted).length;
  return {
    label:
      comments.length === 1 && removed === 1
        ? 'Remove 1 comment'
        : `Post ${comments.length} comment${comments.length === 1 ? '' : 's'}` +
          (removed > 0 ? ` (${removed} flagged deleted)` : ''),
    method: 'POST',
    path: '',
    body: { session_id: sessionId, sent_at: sentAt, comments },
  };
}

export type LookalikeKind = 'speaker' | 'sponsor';

/**
 * Speakers and sponsors are both exactly { id, name }, and the ids carry no prefix, so nothing in
 * the body tells them apart. With no path they share a fingerprint, which is what PRD §6.1 sets
 * out to test. `usePath` is the fix §6.1 gives clients: each kind gets its own source.
 */
export function lookalike(
  kind: LookalikeKind,
  record: { id: string; name: string },
  usePath: boolean,
): IngestRequest {
  return {
    label: `Add ${kind} ${record.name}`,
    method: 'POST',
    path: usePath ? `${kind}s` : '',
    body: { id: record.id, name: record.name },
  };
}

/** Formats an instant as ISO 8601 with the zone's offset, such as 2026-11-12T12:00:00-05:00. */
export function isoInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  // longOffset is "GMT-05:00", or just "GMT" when the offset is zero.
  const offset = part('timeZoneName').slice(3) || 'Z';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${offset}`;
}

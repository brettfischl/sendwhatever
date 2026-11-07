import { describe, expect, it } from 'vitest';
import {
  attendanceJoined,
  attendanceLeft,
  commentBatch,
  isoInZone,
  lookalike,
  registrationCancelled,
  registrationCreated,
  sessionCreated,
  sessionStatusChanged,
  type Comment,
  type IngestRequest,
  type Registration,
  type WebinarSession,
} from './payloads.js';

const session: WebinarSession = {
  id: 'ses_1',
  title: 'Shipping Schemas',
  description: 'A talk.',
  status: 'scheduled',
  timezone: 'America/New_York',
  starts_at: '2026-11-12T12:00:00-05:00',
  ends_at: '2026-11-12T13:00:00-05:00',
  capacity: 500,
  organizer: { name: 'Beacon', email: 'events@beacon-live.example' },
  speakers: [{ id: 'a', name: 'Priya Raman', title: 'Staff Engineer', company: 'Northwind' }],
  agenda: [
    {
      position: 1,
      title: 'Welcome',
      starts_at: '2026-11-12T12:00:00-05:00',
      duration_minutes: 60,
      speaker_id: 'a',
    },
  ],
  tags: ['data', 'postgres'],
  created_at: '2026-11-07T17:00:00.000Z',
};

const registration: Registration = {
  id: 'reg_1',
  session_id: 'ses_1',
  email: 'maya@example.com',
  first_name: 'Maya',
  last_name: 'Okafor',
  company: 'Fieldnote',
  marketing_consent: true,
  status: 'registered',
  registered_at: '2026-11-07T17:01:00.000Z',
  attendance_status: 'watching',
  join_count: 2,
  watch_seconds: 90,
  last_joined_at: '2026-11-07T17:02:00.000Z',
};

const comment: Comment = {
  id: 'cmt_1',
  registration_id: 'reg_1',
  author: { name: 'Maya Okafor' },
  body: 'Hello!',
  posted_at: '2026-11-07T17:03:00.000Z',
  video_offset_seconds: 60,
  deleted: false,
  deleted_at: null,
};
const removedComment: Comment = { ...comment, id: 'cmt_2', deleted: true, deleted_at: '2026-11-07T17:04:00.000Z' };

const AT = '2026-11-07T18:00:00.000Z';

const everyRequest: IngestRequest[] = [
  sessionCreated(session),
  sessionStatusChanged(session, 'live', AT),
  sessionStatusChanged(session, 'ended', AT),
  sessionStatusChanged(session, 'cancelled', AT),
  registrationCreated(registration, session),
  attendanceJoined(registration, AT),
  attendanceLeft(registration, AT),
  registrationCancelled(registration, AT, 'schedule_conflict'),
  commentBatch('ses_1', [comment, removedComment], AT),
  lookalike('speaker', { id: 'a', name: 'Priya' }, false),
  lookalike('sponsor', { id: 'b', name: 'Quillstack' }, true),
];

function timestamps(value: unknown, key = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => timestamps(item));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([childKey, child]) => timestamps(child, childKey));
  }
  return key.endsWith('_at') && value !== null ? [value as string] : [];
}

describe('every payload', () => {
  it('has no type envelope', () => {
    for (const { body } of everyRequest) {
      expect(body).not.toHaveProperty('type');
      expect(body).not.toHaveProperty('data');
    }
  });

  it('uses ISO 8601 timestamps with a timezone', () => {
    const found = everyRequest.flatMap(({ body }) => timestamps(body));
    expect(found.length).toBeGreaterThan(10);
    for (const timestamp of found) {
      expect(timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/);
    }
  });
});

describe('sessions', () => {
  it('sends a new session with nested speakers, agenda, and tags', () => {
    const { method, path, body } = sessionCreated(session);
    expect({ method, path }).toEqual({ method: 'POST', path: '' });
    expect(body).toMatchObject({
      id: 'ses_1',
      speakers: [{ name: 'Priya Raman' }],
      agenda: [{ position: 1, speaker_id: 'a' }],
      tags: ['data', 'postgres'],
    });
  });

  it('sends a status change as a partial update on the same id', () => {
    const { method, body } = sessionStatusChanged(session, 'live', AT);
    expect(method).toBe('PATCH');
    expect(body).toEqual({ id: 'ses_1', status: 'live', started_at: AT });
  });
});

describe('registrations', () => {
  it('embeds the whole session, so one event can write to several tables', () => {
    const { method, body } = registrationCreated(registration, session);
    expect(method).toBe('POST');
    expect(body).toMatchObject({
      id: 'reg_1',
      email: 'maya@example.com',
      company: 'Fieldnote',
      consent: { marketing: true },
      session: { id: 'ses_1', speakers: [{ id: 'a' }] },
    });
  });

  it('leaves out optional fields that were not given', () => {
    const { body } = registrationCreated(registration, session);
    expect(body).not.toHaveProperty('job_title');
  });

  it('sends attendance as partial updates on the registration id', () => {
    expect(attendanceJoined(registration, AT)).toMatchObject({
      method: 'PATCH',
      body: { id: 'reg_1', attendance_status: 'watching', last_joined_at: AT, join_count: 2 },
    });
    expect(attendanceLeft(registration, AT).body).toEqual({
      id: 'reg_1',
      attendance_status: 'left',
      left_at: AT,
      watch_seconds: 90,
    });
  });

  it('sends a cancellation as a DELETE that identifies the record in its body', () => {
    const { method, path, body } = registrationCancelled(registration, AT, 'schedule_conflict');
    expect({ method, path }).toEqual({ method: 'DELETE', path: '' });
    expect(body).toMatchObject({ id: 'reg_1', reason: 'schedule_conflict', cancelled_at: AT });
  });
});

describe('comments', () => {
  it('flags deletes per item within a batch', () => {
    const { method, body } = commentBatch('ses_1', [comment, removedComment], AT);
    expect(method).toBe('POST');
    expect(body).toMatchObject({
      session_id: 'ses_1',
      sent_at: AT,
      comments: [
        { id: 'cmt_1', deleted: false, deleted_at: null },
        { id: 'cmt_2', deleted: true, deleted_at: removedComment.deleted_at },
      ],
    });
  });

  it('describes batches in the log', () => {
    expect(commentBatch('ses_1', [comment], AT).label).toBe('Post 1 comment');
    expect(commentBatch('ses_1', [removedComment], AT).label).toBe('Remove 1 comment');
    expect(commentBatch('ses_1', [comment, removedComment], AT).label).toBe('Post 2 comments (1 flagged deleted)');
  });
});

describe('lookalikes', () => {
  const speaker = { id: '6f1c', name: 'Priya Raman' };
  const sponsor = { id: '91ab', name: 'Quillstack' };

  it('gives speakers and sponsors an identical shape and path by default', () => {
    const asSpeaker = lookalike('speaker', speaker, false);
    const asSponsor = lookalike('sponsor', sponsor, false);
    expect(asSpeaker.body).toEqual(speaker);
    expect(asSponsor.body).toEqual(sponsor);
    expect(Object.keys(asSpeaker.body)).toEqual(Object.keys(asSponsor.body));
    expect(asSpeaker.path).toBe('');
    expect(asSponsor.path).toBe('');
  });

  it('keeps the same body but separates the paths when the toggle is on', () => {
    expect(lookalike('speaker', speaker, true)).toMatchObject({ path: 'speakers', body: speaker });
    expect(lookalike('sponsor', sponsor, true)).toMatchObject({ path: 'sponsors', body: sponsor });
  });
});

describe('isoInZone', () => {
  it('uses the offset in force on that date', () => {
    expect(isoInZone(new Date('2026-11-12T17:00:00Z'), 'America/New_York')).toBe('2026-11-12T12:00:00-05:00');
    expect(isoInZone(new Date('2026-07-12T16:00:00Z'), 'America/New_York')).toBe('2026-07-12T12:00:00-04:00');
  });

  it('handles half-hour offsets and midnight', () => {
    expect(isoInZone(new Date('2026-11-12T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-13T00:00:00+05:30');
  });

  it('writes a zero offset as Z', () => {
    expect(isoInZone(new Date('2026-11-12T17:00:00Z'), 'UTC')).toBe('2026-11-12T17:00:00Z');
  });
});

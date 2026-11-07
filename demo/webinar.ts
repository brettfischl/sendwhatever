import { randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import type { Send } from './ingest-client.js';
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
  type AgendaItem,
  type Comment,
  type LookalikeKind,
  type Registration,
  statusTimestampKey,
  type SessionStatus,
  type SessionTransition,
  type Speaker,
  type Sponsor,
  type WebinarSession,
} from './payloads.js';

export interface NewSession {
  title: string;
  description: string;
  starts_at: Date;
  timezone: string;
  capacity: number;
  tags: string[];
  speakers: { name: string; title?: string; company?: string }[];
  agenda: { title: string; duration_minutes: number; speaker?: string }[];
}

export interface NewRegistration {
  email: string;
  first_name: string;
  last_name: string;
  company?: string;
  job_title?: string;
  marketing_consent: boolean;
}

export interface SessionState {
  session: WebinarSession;
  sponsors: Sponsor[];
  registrations: Registration[];
  comments: Comment[];
}

const ORGANIZER = { name: 'Beacon Live Events', email: 'events@beacon-live.example' };
const DEFAULT_DURATION_MINUTES = 60;

const allowedTransitions: Record<SessionStatus, SessionStatus[]> = {
  scheduled: ['live', 'cancelled'],
  live: ['ended'],
  ended: [],
  cancelled: [],
};

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

/**
 * The site's own state, which is in memory and gone on restart. Each action changes the state and
 * then sends the matching request. A failed send doesn't undo the action: the site carries on, as
 * a real product would, and the request log shows the failure.
 */
export class Webinar {
  private readonly sessions = new Map<string, SessionState>();
  private readonly registrations = new Map<string, Registration>();
  private readonly comments = new Map<string, { sessionId: string; comment: Comment }>();

  constructor(
    private readonly send: Send,
    private readonly onChange: (sessionId: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  listSessions(): SessionState[] {
    return [...this.sessions.values()].reverse();
  }

  getSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new HttpError(404, 'session not found');
    return state;
  }

  async createSession(input: NewSession): Promise<WebinarSession> {
    const speakers: Speaker[] = input.speakers.map((speaker) => ({
      id: randomUUID(),
      ...speaker,
    }));

    let cursor = input.starts_at.getTime();
    const agenda: AgendaItem[] = input.agenda.map((item, index) => {
      const speakerId = speakers.find((speaker) => speaker.name === item.speaker)?.id;
      const entry: AgendaItem = {
        position: index + 1,
        title: item.title,
        starts_at: isoInZone(new Date(cursor), input.timezone),
        duration_minutes: item.duration_minutes,
        ...(speakerId ? { speaker_id: speakerId } : {}),
      };
      cursor += item.duration_minutes * 60_000;
      return entry;
    });
    if (agenda.length === 0) cursor += DEFAULT_DURATION_MINUTES * 60_000;

    const session: WebinarSession = {
      id: newId('ses'),
      title: input.title,
      description: input.description,
      status: 'scheduled',
      timezone: input.timezone,
      starts_at: isoInZone(input.starts_at, input.timezone),
      ends_at: isoInZone(new Date(cursor), input.timezone),
      capacity: input.capacity,
      organizer: ORGANIZER,
      speakers,
      agenda,
      tags: input.tags,
      created_at: this.timestamp(),
    };

    this.sessions.set(session.id, { session, sponsors: [], registrations: [], comments: [] });
    this.onChange(session.id);
    await this.send(sessionCreated(session));
    return session;
  }

  async setStatus(sessionId: string, status: SessionTransition): Promise<void> {
    const { session } = this.getSession(sessionId);
    if (!allowedTransitions[session.status].includes(status)) {
      throw new HttpError(409, `a ${session.status} session can't become ${status}`);
    }
    const at = this.timestamp();
    session.status = status;
    session[statusTimestampKey[status]] = at;
    this.onChange(sessionId);
    await this.send(sessionStatusChanged(session, status, at));
  }

  async addLookalike(
    sessionId: string,
    kind: LookalikeKind,
    name: string,
    usePath: boolean,
  ): Promise<void> {
    const state = this.getSession(sessionId);
    const record = { id: randomUUID(), name };
    if (kind === 'speaker') state.session.speakers.push(record);
    else state.sponsors.push(record);
    this.onChange(sessionId);
    await this.send(lookalike(kind, record, usePath));
  }

  async register(sessionId: string, input: NewRegistration): Promise<Registration> {
    const state = this.getSession(sessionId);
    if (state.session.status === 'ended' || state.session.status === 'cancelled') {
      throw new HttpError(409, `this session is ${state.session.status}`);
    }
    const registration: Registration = {
      id: newId('reg'),
      session_id: sessionId,
      ...input,
      status: 'registered',
      registered_at: this.timestamp(),
      attendance_status: 'not_joined',
      join_count: 0,
      watch_seconds: 0,
    };
    state.registrations.push(registration);
    this.registrations.set(registration.id, registration);
    this.onChange(sessionId);
    await this.send(registrationCreated(registration, state.session));
    return registration;
  }

  /** Does nothing if the viewer is already watching, so a repeated call sends no request. */
  async join(registrationId: string): Promise<void> {
    const registration = this.activeRegistration(registrationId);
    const { session } = this.getSession(registration.session_id);
    if (session.status !== 'live') throw new HttpError(409, 'this session is not live');
    if (registration.attendance_status === 'watching') return;

    const at = this.timestamp();
    registration.attendance_status = 'watching';
    registration.join_count += 1;
    registration.last_joined_at = at;
    this.onChange(registration.session_id);
    await this.send(attendanceJoined(registration, at));
  }

  /** Does nothing unless the viewer is watching. Pages call this on the way out. */
  async leave(registrationId: string): Promise<void> {
    const registration = this.getRegistration(registrationId);
    if (registration.attendance_status !== 'watching') return;
    this.stopWatching(registration);
    this.onChange(registration.session_id);
    await this.send(attendanceLeft(registration, this.timestamp()));
  }

  async cancelRegistration(registrationId: string, reason: string): Promise<void> {
    const registration = this.activeRegistration(registrationId);
    if (registration.attendance_status === 'watching') this.stopWatching(registration);
    registration.status = 'cancelled';
    this.onChange(registration.session_id);
    await this.send(registrationCancelled(registration, this.timestamp(), reason));
  }

  /** Posts one or more comments as a single batch. `deleted` flags an item as already removed. */
  async postComments(
    sessionId: string,
    items: { registrationId: string; body: string; deleted?: boolean }[],
  ): Promise<Comment[]> {
    const state = this.getSession(sessionId);
    if (state.session.status === 'ended' || state.session.status === 'cancelled') {
      throw new HttpError(409, `this session is ${state.session.status}`);
    }

    const at = this.timestamp();
    const comments = items.map(({ registrationId, body, deleted = false }): Comment => {
      const registration = this.activeRegistration(registrationId);
      if (registration.session_id !== sessionId) {
        throw new HttpError(400, 'that registration is for a different session');
      }
      const { first_name, last_name, company } = registration;
      return {
        id: newId('cmt'),
        registration_id: registrationId,
        author: { name: `${first_name} ${last_name}`, ...(company ? { company } : {}) },
        body,
        posted_at: at,
        video_offset_seconds: this.videoOffsetSeconds(sessionId),
        deleted,
        deleted_at: deleted ? at : null,
      };
    });

    for (const comment of comments) {
      state.comments.push(comment);
      this.comments.set(comment.id, { sessionId, comment });
    }
    this.onChange(sessionId);
    await this.send(commentBatch(sessionId, comments, at));
    return comments;
  }

  /** Does nothing if the comment is already removed. */
  async removeComment(commentId: string): Promise<void> {
    const found = this.comments.get(commentId);
    if (!found) throw new HttpError(404, 'comment not found');
    const { sessionId, comment } = found;
    if (comment.deleted) return;

    const at = this.timestamp();
    comment.deleted = true;
    comment.deleted_at = at;
    this.onChange(sessionId);
    await this.send(commentBatch(sessionId, [comment], at));
  }

  private getRegistration(registrationId: string): Registration {
    const registration = this.registrations.get(registrationId);
    if (!registration) throw new HttpError(404, 'registration not found');
    return registration;
  }

  private activeRegistration(registrationId: string): Registration {
    const registration = this.getRegistration(registrationId);
    if (registration.status === 'cancelled') {
      throw new HttpError(409, 'this registration was cancelled');
    }
    return registration;
  }

  private stopWatching(registration: Registration): void {
    const joinedAt = Date.parse(registration.last_joined_at ?? '');
    registration.watch_seconds += Math.floor((this.now().getTime() - joinedAt) / 1000);
    registration.attendance_status = 'left';
  }

  private videoOffsetSeconds(sessionId: string): number {
    const { session } = this.getSession(sessionId);
    if (!session.started_at) return 0;
    return Math.floor((this.now().getTime() - Date.parse(session.started_at)) / 1000);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

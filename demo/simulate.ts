import { HttpError } from './http.js';
import type { Registration } from './payloads.js';
import type { Webinar } from './webinar.js';

const FIRST_NAMES = ['Maya', 'Jonas', 'Aiko', 'Rafael', 'Noor', 'Elena', 'Kwame', 'Sofia', 'Dev', 'Hana', 'Lucas', 'Imani'];
const LAST_NAMES = ['Okafor', 'Lindqvist', 'Tanaka', 'Mendes', 'Haddad', 'Novak', 'Mensah', 'Rossi', 'Patel', 'Kim'];
const COMPANIES = ['Fieldnote', 'Harbor Freight Labs', 'Pinecrest Analytics', 'Tallgrass', 'Quillstack'];
const JOB_TITLES = ['Data Engineer', 'Staff Engineer', 'Product Manager', 'Head of Analytics'];
const COMMENTS = [
  'Hello from Lisbon!',
  'Will the recording be shared afterwards?',
  'Great point about backfills.',
  'How does this handle late-arriving events?',
  'Audio is a little quiet on my end.',
  'We hit exactly this problem last quarter.',
  'Can you share the slides?',
  'What does the migration path look like?',
  'Thanks, this is really useful.',
  '+1 to the question above',
];
const FLAGGED_COMMENT = 'BUY CHEAP FOLLOWERS at totally-legit.example';
const CANCEL_REASONS = ['schedule_conflict', 'no_longer_interested', 'registered_by_mistake'];

const COMMENT_BATCH_SIZE = 4;

export interface SimulateOptions {
  viewers: number;
  /** Time between requests, so the log visibly fills up in a demo. */
  pauseMs?: number;
  random?: () => number;
}

/**
 * Generates a session's worth of activity through the same actions a person uses: registrations,
 * joins, batches of comments with one flagged deleted, some viewers leaving, and a cancellation.
 */
export async function simulateViewers(
  webinar: Webinar,
  sessionId: string,
  { viewers, pauseMs = 120, random = Math.random }: SimulateOptions,
): Promise<void> {
  const { session } = webinar.getSession(sessionId);
  if (session.status === 'ended' || session.status === 'cancelled') {
    throw new HttpError(409, `this session is ${session.status}`);
  }

  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const pause = () => new Promise((resolve) => setTimeout(resolve, pauseMs));

  if (session.status === 'scheduled') {
    await webinar.setStatus(sessionId, 'live');
    await pause();
  }

  const registered: Registration[] = [];
  for (let i = 0; i < viewers; i++) {
    const first_name = pick(FIRST_NAMES);
    const last_name = pick(LAST_NAMES);
    const company = random() < 0.8 ? pick(COMPANIES) : undefined;
    const job_title = random() < 0.5 ? pick(JOB_TITLES) : undefined;
    registered.push(
      await webinar.register(sessionId, {
        email: `${first_name}.${last_name}.${i + 1}@example.com`.toLowerCase(),
        first_name,
        last_name,
        ...(company ? { company } : {}),
        ...(job_title ? { job_title } : {}),
        marketing_consent: random() < 0.5,
      }),
    );
    await pause();
  }

  // Everyone joins except the last viewer, who registers but never shows up.
  const watching = registered.slice(0, -1);
  for (const registration of watching) {
    await webinar.join(registration.id);
    await pause();
  }

  // Everyone who joined comments once, in batches. The first batch includes a removed comment.
  for (let i = 0; i < watching.length; i += COMMENT_BATCH_SIZE) {
    const batch = watching.slice(i, i + COMMENT_BATCH_SIZE).map((registration) => ({
      registrationId: registration.id,
      body: pick(COMMENTS),
    }));
    const flagged = i === 0 ? [{ registrationId: batch[0]!.registrationId, body: FLAGGED_COMMENT, deleted: true }] : [];
    await webinar.postComments(sessionId, [...batch, ...flagged]);
    await pause();
  }

  // About a quarter of viewers leave. The first of them also cancels, which sends the DELETE.
  const leaving = watching.filter((_, index) => index % 4 === 0);
  for (const [index, registration] of leaving.entries()) {
    if (index === 0) await webinar.cancelRegistration(registration.id, pick(CANCEL_REASONS));
    else await webinar.leave(registration.id);
    await pause();
  }
}

// Plain-English labels for event statuses and quarantine reasons (§10, §19). One definition for every
// admin page that shows them, so the Pipeline feed, the event explorer and the status badges can't
// drift apart. Labels never include payload values (§19.3).
import type { EventStatus } from './status.js';

export const STATUS_LABELS: Record<EventStatus, string> = {
  queued: 'Queued',
  adapter_generating: 'AI generating',
  waiting: 'Waiting for adapter',
  quarantined: 'Needs attention',
  written: 'Written',
};

/** Quarantine reasons as full sentences, for a line or paragraph of their own. */
export const REASON_LABELS: Record<string, string> = {
  unknown_fingerprint: 'No adapter handles this shape yet.',
  malformed: "The body isn't a JSON object or array.",
  adapter_error: 'The adapter failed on this event.',
  schema_conflict: "The adapter's output conflicts with the existing tables.",
  write_error: "Writing to the account's store failed.",
};

export const statusLabel = (status: EventStatus): string => STATUS_LABELS[status];

/** The sentence for a reason. An unknown reason is shown as its code rather than hidden. */
export const reasonLabel = (reason: string): string => REASON_LABELS[reason] ?? reason;

/** The same wording without the closing period, for lists like "No adapter handles this shape yet (3)". */
export const reasonPhrase = (reason: string): string => reasonLabel(reason).replace(/\.$/, '');

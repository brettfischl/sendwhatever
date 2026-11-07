// src/pipeline/labels.ts: every status and quarantine reason has one label.
import { describe, expect, it } from 'vitest';
import { REASON_LABELS, STATUS_LABELS, reasonLabel, reasonPhrase, statusLabel } from '../src/pipeline/labels.js';
import { EVENT_STATUSES } from '../src/pipeline/status.js';

// The reasons the quarantine table allows (migrations/app/0002_app_schema.sql).
const REASONS = ['unknown_fingerprint', 'malformed', 'adapter_error', 'schema_conflict', 'write_error'];

describe('pipeline labels', () => {
  it('labels every event status', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...EVENT_STATUSES].sort());
    for (const status of EVENT_STATUSES) expect(statusLabel(status)).toBe(STATUS_LABELS[status]);
  });

  it('labels every quarantine reason with a sentence', () => {
    expect(Object.keys(REASON_LABELS).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) expect(reasonLabel(reason)).toMatch(/^[A-Z].*\.$/);
  });

  it('shows an unknown reason as its code', () => {
    expect(reasonLabel('something_new')).toBe('something_new');
    expect(reasonPhrase('something_new')).toBe('something_new');
  });

  it('drops only the closing period for inline use', () => {
    expect(reasonPhrase('unknown_fingerprint')).toBe('No adapter handles this shape yet');
    expect(reasonPhrase('schema_conflict')).toBe("The adapter's output conflicts with the existing tables");
  });
});

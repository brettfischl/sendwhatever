/** `2026-11-07`, for lists where the time of day is noise. */
export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** The full ISO timestamp, for values people copy into other tools. */
export const timestamp = (d: Date): string => d.toISOString();

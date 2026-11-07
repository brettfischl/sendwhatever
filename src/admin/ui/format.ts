// Shared time formatting for admin pages. Relative for scanning, full UTC in a tooltip.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toDate = (value: Date | string) => (typeof value === 'string' ? new Date(value) : value);

/** "12s ago", "5m ago", "2h ago", else a short date like "Nov 3" (or "Nov 3, 2025" in another year). */
export function relativeTime(value: Date | string, now: Date = new Date()): string {
  const date = toDate(value);
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const short = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === now.getUTCFullYear() ? short : `${short}, ${date.getUTCFullYear()}`;
}

/** UTC to the second, so it reads the same for everyone: "2026-11-07 14:03:12 UTC". */
export function fullTime(value: Date | string): string {
  return `${toDate(value).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

import { createHash } from 'node:crypto';

// Fixed for the life of the platform: changing it changes every injected ID, so a replay would add
// rows instead of updating them.
const NAMESPACE = Buffer.from('6f1d3a52c8e94b07a1d27e5b90c3f486', 'hex');

/** A UUIDv5 (RFC 9562) in the platform's namespace. */
export function uuid5(name: string): string {
  const bytes = createHash('sha1').update(NAMESPACE).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

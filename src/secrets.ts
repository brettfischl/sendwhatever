import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Layout: version byte | 12-byte IV | 16-byte GCM tag | ciphertext. The version byte is also
// authenticated, so a future format change can't be spoofed by editing it.
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** Encrypts a JSON object with AES-256-GCM for a BYTEA column. */
export function encryptJson(key: Buffer, value: Record<string, unknown>): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from([VERSION]));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the data was altered, truncated, or encrypted with another key. */
export function decryptJson(key: Buffer, data: Buffer): Record<string, unknown> {
  if (data.length < HEADER_BYTES || data[0] !== VERSION) {
    throw new Error('Unreadable encrypted value');
  }
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from([VERSION]));
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Unreadable encrypted value');
  }
}

/** A new API key: `sw_` plus 32 random bytes. Shown once; only the hash is stored. */
export function generateApiKey(): string {
  return `sw_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

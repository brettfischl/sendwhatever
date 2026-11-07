import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptJson, encryptJson, generateApiKey, hashApiKey } from '../src/secrets.js';

const key = randomBytes(32);
const value = { user: 'u', password: 'p@ss "quoted"', nested: { n: 1 } };

describe('credential encryption', () => {
  it('round trips a JSON object', () => {
    expect(decryptJson(key, encryptJson(key, value))).toEqual(value);
  });

  it('uses the documented layout and a fresh IV each time', () => {
    const a = encryptJson(key, value);
    const b = encryptJson(key, value);
    expect(a[0]).toBe(1);
    expect(a.length).toBeGreaterThan(1 + 12 + 16);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(a.toString('utf8')).not.toContain('quoted');
  });

  it('rejects tampered ciphertext, tag, IV and version', () => {
    const data = encryptJson(key, value);
    for (const index of [0, 1, 13, data.length - 1]) {
      const copy = Buffer.from(data);
      copy[index] = copy[index]! ^ 0x01;
      expect(() => decryptJson(key, copy), `byte ${index}`).toThrow();
    }
  });

  it('rejects truncated data and the wrong key', () => {
    const data = encryptJson(key, value);
    expect(() => decryptJson(key, data.subarray(0, 20))).toThrow();
    expect(() => decryptJson(randomBytes(32), data)).toThrow();
  });
});

describe('API keys', () => {
  it('has the sw_ prefix and 32 bytes of randomness', () => {
    const apiKey = generateApiKey();
    expect(apiKey).toMatch(/^sw_[A-Za-z0-9_-]{43}$/);
    expect(generateApiKey()).not.toBe(apiKey);
  });

  it('hashes to SHA-256 hex', () => {
    expect(hashApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { publicDbAddress } from '../src/admin/public-addresses.js';
import { parsePublicBaseUrl, parsePublicDbHost, parsePublicDbPort } from '../src/config.js';

describe('PUBLIC_BASE_URL', () => {
  it('is optional and normalises to an origin', () => {
    expect(parsePublicBaseUrl(undefined)).toBeUndefined();
    expect(parsePublicBaseUrl('https://App.Example.org/')).toBe('https://app.example.org');
    expect(parsePublicBaseUrl('https://app.example.org:443')).toBe('https://app.example.org');
    expect(parsePublicBaseUrl('http://localhost:3005')).toBe('http://localhost:3005');
  });

  it('rejects anything but a bare http(s) origin, without echoing the value', () => {
    for (const bad of [
      'app.example.org',
      'not a url',
      'ftp://app.example.org',
      'https://app.example.org/admin',
      'https://app.example.org?x=1',
      'https://app.example.org/?',
      'https://app.example.org#',
      'https://user:hunter2-secret@app.example.org',
    ]) {
      expect(() => parsePublicBaseUrl(bad), bad).toThrow(/^PUBLIC_BASE_URL must be an http or https origin/);
      try {
        parsePublicBaseUrl(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain('hunter2');
        expect((error as Error).message).not.toContain(bad);
      }
    }
  });
});

describe('PUBLIC_DB_HOST and PUBLIC_DB_PORT', () => {
  it('accepts a hostname or IPv4 address and a port', () => {
    expect(parsePublicDbHost(undefined)).toBeUndefined();
    expect(parsePublicDbHost('db.example.com')).toBe('db.example.com');
    expect(parsePublicDbHost('203.0.113.7')).toBe('203.0.113.7');
    expect(parsePublicDbPort(undefined)).toBeUndefined();
    expect(parsePublicDbPort('5432')).toBe(5432);
  });

  it('rejects values that would break a connection string', () => {
    for (const bad of ['db.example.com:5432', 'user@db', 'db/x', 'db?sslmode=disable', '-db', ' db', 'db..example.org', 'db.-x.org', 'db.']) {
      expect(() => parsePublicDbHost(bad), bad).toThrow(/^PUBLIC_DB_HOST must be/);
    }
    for (const bad of ['0', '65536', '54a', '5432.0', '-1']) {
      expect(() => parsePublicDbPort(bad), bad).toThrow(/^PUBLIC_DB_PORT must be/);
    }
  });
});

describe('publicDbAddress', () => {
  const config = { publicDbHost: 'db.example.org', publicDbPort: 5432, postgresPort: 5439 };

  it('shows the public address for a store on the local server, and localhost when unset', () => {
    const local = { host: 'localhost', port: 5439 };
    expect(publicDbAddress(config, local)).toEqual({ host: 'db.example.org', port: 5432, requireSsl: true });
    expect(publicDbAddress({ ...config, publicDbHost: undefined, publicDbPort: undefined }, local)).toEqual({
      host: 'localhost',
      port: 5439,
      requireSsl: false,
    });
  });

  it("keeps an external store's own address", () => {
    expect(publicDbAddress(config, { host: 'customer-db.example.net', port: 6543 })).toEqual({
      host: 'customer-db.example.net',
      port: 6543,
      requireSsl: false,
    });
  });
});

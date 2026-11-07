import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDemoConfig } from './config.js';
import { applySeedFile, readSeedFile, writeSeedFile, type SeedFile } from './seed-file.js';
import { tablesSourceFromEnv } from './tables.js';

const dir = mkdtempSync(join(tmpdir(), 'sw-seed-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const seed: SeedFile = {
  slug: 'seeded',
  ingestUrl: 'http://localhost:3000/ingest',
  apiKey: 'seeded-key',
  appDatabaseUrl: 'postgres://sw_app:secret@localhost:5432/sw_app',
  database: { user: 'r', password: 'p', database: 'd', host: 'localhost', port: 5432 },
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe('applySeedFile', () => {
  it('leaves stub mode alone with no file', () => {
    const { env, usesSeedKey } = applySeedFile({}, undefined);
    expect(usesSeedKey).toBe(false);
    expect(loadDemoConfig(env).ingestUrl).toBeUndefined();
  });

  it('points a checkout with only the file at the seeded service, with the panel on', () => {
    const { env, usesSeedKey } = applySeedFile({}, seed);
    expect(usesSeedKey).toBe(true);
    expect(loadDemoConfig(env)).toMatchObject({
      ingestUrl: seed.ingestUrl,
      ingestApiKey: seed.apiKey,
      accountSlug: seed.slug,
    });
    expect(env.DEMO_APP_DATABASE_URL).toBe(seed.appDatabaseUrl);
  });

  it('lets a real key override the seeded one, which then needs no check', () => {
    const { env, usesSeedKey } = applySeedFile({ INGEST_API_KEY: 'mine' }, seed);
    expect(usesSeedKey).toBe(false);
    expect(loadDemoConfig(env)).toMatchObject({ ingestUrl: seed.ingestUrl, ingestApiKey: 'mine' });
  });

  it('lets a real panel URL override the seeded one', () => {
    const { env } = applySeedFile({ DEMO_APP_DATABASE_URL: 'postgres://other@localhost/x' }, seed);
    expect(env.DEMO_APP_DATABASE_URL).toBe('postgres://other@localhost/x');
  });

  it('treats an empty panel URL, as in a copied .env.example, as unset', () => {
    expect(applySeedFile({ DEMO_APP_DATABASE_URL: '' }, seed).env.DEMO_APP_DATABASE_URL).toBe(seed.appDatabaseUrl);
  });

  it('never sends the seeded key to another service', () => {
    const { env, usesSeedKey } = applySeedFile({ INGEST_URL: 'https://elsewhere.example/ingest' }, seed);
    expect(usesSeedKey).toBe(false);
    expect(env.INGEST_API_KEY).toBeUndefined();
    expect(env.DEMO_APP_DATABASE_URL).toBeUndefined();
    expect(() => loadDemoConfig(env)).toThrow(/INGEST_API_KEY/);
  });

  it('never sends the seeded key for another account', () => {
    const { env, usesSeedKey } = applySeedFile({ ACCOUNT_SLUG: 'other' }, seed);
    expect(usesSeedKey).toBe(false);
    expect(env.INGEST_API_KEY).toBeUndefined();
    expect(loadDemoConfig(env).ingestUrl).toBeUndefined();
  });

  it('keeps an empty INGEST_URL as the way to force the stub', () => {
    const { env, usesSeedKey } = applySeedFile({ INGEST_URL: '' }, seed);
    expect(usesSeedKey).toBe(false);
    expect(loadDemoConfig(env).ingestUrl).toBeUndefined();
  });

  it('still refuses a panel on a non-loopback demo host', () => {
    const { env } = applySeedFile({ SW_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }, seed);
    const options = { mode: 'real', accountSlug: seed.slug } as const;
    expect(() => tablesSourceFromEnv({ ...options, host: '0.0.0.0' }, env)).toThrow(/loopback/);
    expect(tablesSourceFromEnv({ ...options, host: '127.0.0.1' }, env).loopbackOnly).toBe(true);
  });
});

describe('the seed file', () => {
  it('is mode 600, even when replacing a looser file, and leaves no temporary file', async () => {
    const path = join(dir, 'loose.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o644);
    expect(await writeSeedFile(path, seed)).toBe(true);
    expect(mode(path)).toBe(0o600);
    expect(readSeedFile(path)).toEqual(seed);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('is not rewritten when unchanged, but its mode is still corrected', async () => {
    const path = join(dir, 'same.json');
    await writeSeedFile(path, seed);
    chmodSync(path, 0o644);
    expect(await writeSeedFile(path, seed)).toBe(false);
    expect(mode(path)).toBe(0o600);
  });

  it('reads as undefined when missing', () => {
    expect(readSeedFile(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('refuses a damaged file without echoing it', () => {
    const path = join(dir, 'damaged.json');
    writeFileSync(path, '{"apiKey":"sw_secret"');
    expect(() => readSeedFile(path)).toThrow(/npm run seed/);
    expect(() => readSeedFile(path)).not.toThrow(/sw_secret/);
    writeFileSync(path, 'null');
    expect(() => readSeedFile(path)).toThrow(/npm run seed/);
  });
});

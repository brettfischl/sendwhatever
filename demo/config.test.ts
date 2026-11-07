import { describe, expect, it } from 'vitest';
import { loadDemoConfig } from './config.js';

describe('loadDemoConfig', () => {
  it('defaults to stub mode on port 3100 and the demo account', () => {
    expect(loadDemoConfig({})).toEqual({
      port: 3100,
      host: '127.0.0.1',
      ingestUrl: undefined,
      ingestApiKey: undefined,
      accountSlug: 'demo',
    });
  });

  it('treats an empty INGEST_URL as stub mode', () => {
    expect(loadDemoConfig({ INGEST_URL: '' }).ingestUrl).toBeUndefined();
  });

  it('reads a real target', () => {
    const config = loadDemoConfig({
      INGEST_URL: 'http://localhost:3000/ingest',
      INGEST_API_KEY: 'k',
      ACCOUNT_SLUG: 'acme',
      DEMO_PORT: '3200',
    });
    expect(config).toMatchObject({
      ingestUrl: 'http://localhost:3000/ingest',
      ingestApiKey: 'k',
      accountSlug: 'acme',
      port: 3200,
    });
  });

  it('turns the slug header off when ACCOUNT_SLUG is empty', () => {
    expect(loadDemoConfig({ ACCOUNT_SLUG: '' }).accountSlug).toBeUndefined();
  });

  it('requires a key with a real URL', () => {
    expect(() => loadDemoConfig({ INGEST_URL: 'http://localhost:3000/ingest' })).toThrow(/INGEST_API_KEY/);
  });

  it('rejects a URL that would show a secret in the request log', () => {
    const load = (url: string) => () => loadDemoConfig({ INGEST_URL: url, INGEST_API_KEY: 'k' });
    expect(load('http://localhost/ingest?key=secret')).toThrow(/query or credentials/);
    expect(load('http://user:secret@localhost/ingest')).toThrow(/query or credentials/);
    expect(load('not a url')).toThrow(/not a valid URL/);
  });

  it('rejects a bad port', () => {
    expect(() => loadDemoConfig({ DEMO_PORT: 'abc' })).toThrow(/DEMO_PORT/);
    expect(() => loadDemoConfig({ DEMO_PORT: '70000' })).toThrow(/DEMO_PORT/);
  });
});

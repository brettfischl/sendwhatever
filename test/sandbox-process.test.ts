import type { SpawnOptions } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAdapter, SandboxUnavailableError } from '../src/sandbox/index.js';

const spawnCalls = vi.hoisted(() => ({ options: [] as SpawnOptions[], override: null as null | string }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      spawnCalls.options.push(options);
      return actual.spawn(spawnCalls.override ?? command, args, options);
    },
  };
});

const REQUEST = { method: 'POST', path: '/ingest', query: '', headers: {} };

beforeEach(() => {
  spawnCalls.options.length = 0;
  spawnCalls.override = null;
});

it('gives the sandbox process none of the host environment', async () => {
  process.env.SANDBOX_TEST_SECRET = 'not-for-adapters';
  try {
    const result = await runAdapter({ code: 'function adapt() { return 1; }', body: null, request: REQUEST });
    expect(result).toEqual({ ok: true, output: 1 });
    expect(spawnCalls.options[0]?.env).toEqual({ TZ: 'UTC', LC_ALL: 'C' });
  } finally {
    delete process.env.SANDBOX_TEST_SECRET;
  }
});

it('rejects, rather than blaming the adapter, when the sandbox process cannot start', async () => {
  spawnCalls.override = '/nonexistent/node';
  await expect(
    runAdapter({ code: 'function adapt() { return 1; }', body: null, request: REQUEST }),
  ).rejects.toBeInstanceOf(SandboxUnavailableError);
});

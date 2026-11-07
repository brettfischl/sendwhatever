import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { runAdapter, SandboxUnavailableError } from '../src/sandbox/index.js';

const spawnCalls = vi.hoisted(() => ({
  options: [] as SpawnOptions[],
  children: [] as ChildProcess[],
  override: null as null | { command: string; args: string[] },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: SpawnOptions) => {
      spawnCalls.options.push(options);
      const child = actual.spawn(spawnCalls.override?.command ?? command, spawnCalls.override?.args ?? args, options);
      spawnCalls.children.push(child);
      return child;
    },
  };
});

const REQUEST = { method: 'POST', path: '/ingest', query: '', headers: {} };

beforeEach(() => {
  spawnCalls.options.length = 0;
  spawnCalls.children.length = 0;
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
  spawnCalls.override = { command: '/nonexistent/node', args: [] };
  await expect(
    runAdapter({ code: 'function adapt() { return 1; }', body: null, request: REQUEST }),
  ).rejects.toBeInstanceOf(SandboxUnavailableError);
});

it('rejects when the sandbox process never starts, rather than reporting an adapter timeout', async () => {
  spawnCalls.override = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
  await expect(
    runAdapter({ code: 'function adapt() { return 1; }', body: null, request: REQUEST }, { startupTimeoutMs: 200 }),
  ).rejects.toThrow(/did not start/);
});

it('rejects when something outside the sandbox kills its process', async () => {
  const running = runAdapter(
    { code: 'function adapt() { while (true) {} }', body: null, request: REQUEST },
    { timeoutMs: 30_000 },
  );
  setTimeout(() => spawnCalls.children[0]?.kill('SIGKILL'), 300);
  await expect(running).rejects.toBeInstanceOf(SandboxUnavailableError);
});

it('does not start a process when the request cannot be serialized', async () => {
  const request = { ...REQUEST, headers: { bad: 1n } } as unknown as typeof REQUEST;
  await expect(runAdapter({ code: '', body: null, request })).rejects.toThrow(TypeError);
  expect(spawnCalls.children).toHaveLength(0);
});

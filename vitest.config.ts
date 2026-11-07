import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // isolated-vm is a native addon, so tests run in child processes rather than worker threads.
    pool: 'forks',
    // Required by isolated-vm on Node 20 and later. Any process that loads it needs this flag.
    execArgv: ['--no-node-snapshot'],
  },
});

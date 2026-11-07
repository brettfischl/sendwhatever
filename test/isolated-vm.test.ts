import ivm from 'isolated-vm';
import { expect, it } from 'vitest';

it('loads isolated-vm, runs code, and enforces a timeout', async () => {
  const isolate = new ivm.Isolate({ memoryLimit: 32 });
  try {
    const context = await isolate.createContext();
    expect(await context.eval('1 + 2', { timeout: 100 })).toBe(3);
    await expect(context.eval('while (true) {}', { timeout: 50 })).rejects.toThrow(/timed out/i);
  } finally {
    isolate.dispose();
  }
});

// The process that hosts one adapter run, started by index.ts. It's plain JavaScript so it runs under
// `node --no-node-snapshot` with no TypeScript loader. It handles one message and exits.
import { readFileSync } from 'node:fs';
import ivm from 'isolated-vm';

const GUEST_SOURCE = readFileSync(new URL('./guest.js', import.meta.url), 'utf8');

function failure(tag, detail) {
  return JSON.stringify([tag, detail]);
}

async function run({ code, body, requestJson, timeoutMs, memoryLimitMb }) {
  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  let compiled = false;
  try {
    // Parsing here tells a syntax error from a SyntaxError that adapter code throws, and reports its
    // line. It runs nothing.
    await isolate.compileScript(code, { filename: 'adapter.js' });
    compiled = true;

    const context = await isolate.createContext();
    const guest = await isolate.compileScript(GUEST_SOURCE, { filename: 'sandbox.js' });
    const runGuest = await guest.run(context, { reference: true });

    // Only strings cross, and the isolate gets no reference to anything in this process. The result
    // is already a string when adapter code stops running, so copying it runs nothing either.
    return await runGuest.apply(undefined, [code, body, requestJson], {
      timeout: timeoutMs,
      arguments: { copy: true },
      result: { copy: true },
    });
  } catch (error) {
    // The guest catches everything adapter code throws, so these come from the engine or isolated-vm,
    // and adapter code can't forge them.
    const message = error instanceof Error ? error.message : String(error);
    if (isolate.isDisposed) return failure('memory_limit', `The adapter exceeded the ${memoryLimitMb} MB memory limit.`);
    if (/timed out/i.test(message)) return failure('timeout', `The adapter exceeded the ${timeoutMs} ms time limit.`);
    return failure(compiled ? 'crashed' : 'syntax_error', message);
  }
}

process.once('message', async (message) => {
  const result = await run(message);
  process.send(result, () => process.exit(0));
});

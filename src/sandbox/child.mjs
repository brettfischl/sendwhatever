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
  const memoryFailure = () => failure('memory_limit', `The adapter exceeded the ${memoryLimitMb} MB memory limit.`);
  const timeoutFailure = () => failure('timeout', `The adapter exceeded the ${timeoutMs} ms time limit.`);

  try {
    // Parsing here tells a syntax error from a SyntaxError that adapter code throws, and reports its
    // line. It runs nothing.
    await isolate.compileScript(code, { filename: 'adapter.js' });
  } catch (error) {
    return isolate.isDisposed ? memoryFailure() : failure('syntax_error', error.message);
  }

  const guestOptions = { timeout: timeoutMs, result: { copy: true } };
  let guest;
  const started = Date.now();
  try {
    const context = await isolate.createContext();
    const script = await isolate.compileScript(GUEST_SOURCE, { filename: 'sandbox.js' });
    guest = await script.run(context, { reference: true });
    const runGuest = await guest.get('run', { reference: true });

    // Only strings cross, and the isolate gets no reference to anything in this process. The result
    // is already a string when adapter code stops running, so copying it runs nothing either.
    return await runGuest.apply(undefined, [code, body, requestJson], { ...guestOptions, arguments: { copy: true } });
  } catch (error) {
    if (isolate.isDisposed) return memoryFailure();

    // Adapter code can reach this catch by leaving a promise rejected, with any message it likes. It
    // can't get a timeout reported without spending the whole time limit, which earns it one anyway.
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message) && Date.now() - started >= timeoutMs) return timeoutFailure();

    // A rejected promise doesn't undo what the adapter returned, so the result still stands.
    try {
      const takeResult = await guest.get('takeResult', { reference: true });
      const result = await takeResult.apply(undefined, [], guestOptions);
      return typeof result === 'string' ? result : failure('crashed', message);
    } catch (retryError) {
      if (isolate.isDisposed) return memoryFailure();
      return /timed out/i.test(retryError.message) ? timeoutFailure() : failure('crashed', message);
    }
  }
}

process.once('message', async (message) => {
  process.send('started');
  const result = await run(message);
  process.send(result, () => process.exit(0));
});

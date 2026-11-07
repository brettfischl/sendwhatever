import { loadConfig } from '../config.js';
import { fireworksFromConfig, startGenerator } from './index.js';

/** Longer than a stop needs, since LLM calls abort at once. A cut-off attempt times out and runs again. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

const config = loadConfig();
let llm;
try {
  llm = fireworksFromConfig(config);
} catch (error) {
  console.error(`[generator] ${(error as Error).message}`);
  process.exit(1);
}
const generator = startGenerator({
  databaseUrl: config.appDatabaseUrl,
  llm,
  ...(config.workerAccountId && { accountId: config.workerAccountId }),
});

// One Ctrl-C can arrive several times, from the terminal and again from whatever passes it on. So
// a repeated signal can't mean "force it", and the time limit is what ends a shutdown that hangs.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    setTimeout(() => {
      console.error('[generator] Running attempts did not finish in time, so exiting without them');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    generator.stop().then(
      () => process.exit(0),
      (error: Error) => {
        console.error(`[generator] Shutdown failed: ${error.message}`);
        process.exit(1);
      },
    );
  });
}

// Last, so a signal sent as soon as this appears always finds the handlers in place.
console.log('sendwhatever generator started');

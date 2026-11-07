import { loadConfig } from '../config.js';
import { decryptJson } from '../secrets.js';
import { startWorker } from './index.js';

/**
 * Most jobs finish well within this. One cut off here is safe: its lease expires and it runs again,
 * and a store that already took the event takes it again harmlessly.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000;

const config = loadConfig();
const worker = startWorker({
  databaseUrl: config.appDatabaseUrl,
  decryptCredentials: (encrypted) => decryptJson(config.encryptionKey, encrypted),
  ...(config.workerAccountId && { accountId: config.workerAccountId }),
});

// One Ctrl-C can arrive several times, from the terminal and again from whatever passes it on. So
// a repeated signal can't mean "force it", and the time limit is what ends a shutdown that hangs.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    setTimeout(() => {
      console.error('[worker] Running jobs did not finish in time, so exiting without them');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    worker.stop().then(
      () => process.exit(0),
      (error: Error) => {
        console.error(`[worker] Shutdown failed: ${error.message}`);
        process.exit(1);
      },
    );
  });
}

// Last, so a signal sent as soon as this appears always finds the handlers in place.
console.log('sendwhatever worker started');

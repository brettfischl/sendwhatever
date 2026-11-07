import { fileURLToPath } from 'node:url';
import { loadDemoConfig } from './config.js';
import { createRawIngestClient } from './console.js';
import { createIngestClient, RequestLog } from './ingest-client.js';
import { createDemoServer, SiteEvents } from './server.js';
import { applySeedFile, assertSeedKeyLive, readSeedFile, SEED_FILE } from './seed-file.js';
import { startStub } from './stub.js';
import { tablesSourceFromEnv } from './tables.js';
import { Webinar } from './webinar.js';

const STUB_API_KEY = 'stub-key';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// Settings already in the environment or .env win over the file.
let seed;
try {
  seed = readSeedFile(SEED_FILE);
} catch (error) {
  // A damaged file only matters when nothing in the environment says where to send instead.
  if (process.env.INGEST_URL === undefined) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
const { env, usesSeedKey } = applySeedFile(process.env, seed);
const config = loadDemoConfig(env);
if (seed && usesSeedKey) {
  try {
    await assertSeedKeyLive(seed, env.DEMO_APP_DATABASE_URL || seed.appDatabaseUrl);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
const stub = config.ingestUrl ? undefined : await startStub();
const ingestUrl = config.ingestUrl ?? stub!.url;

const events = new SiteEvents();
const log = new RequestLog((change) => events.logChanged(change));
const clientOptions = {
  url: ingestUrl,
  apiKey: config.ingestApiKey ?? STUB_API_KEY,
  ...(config.accountSlug ? { accountSlug: config.accountSlug } : {}),
  log,
};
const send = createIngestClient(clientOptions);
const webinar = new Webinar(send, (sessionId) => events.sessionChanged(sessionId));

const server = createDemoServer(
  {
    webinar,
    log,
    target: { mode: stub ? 'stub' : 'real', url: ingestUrl, accountSlug: config.accountSlug },
    tables: tablesSourceFromEnv(
      {
        mode: stub ? 'stub' : 'real',
        host: config.host,
        accountSlug: config.accountSlug,
      },
      env,
    ),
    consoleSend: createRawIngestClient(clientOptions),
  },
  events,
);

server.on('error', (error) => {
  console.error(`Could not start the demo site: ${error.message}. Set DEMO_PORT to use another port.`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(`Demo site: http://${config.host}:${config.port}`);
  console.log(`Demo console: http://${config.host}:${config.port}/console`);
  console.log(`Sending to: ${ingestUrl}${stub ? ' (built-in stub)' : ''}`);
});

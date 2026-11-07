import { fileURLToPath } from 'node:url';
import { loadDemoConfig } from './config.js';
import { createRawIngestClient } from './console.js';
import { createIngestClient, RequestLog } from './ingest-client.js';
import { createDemoServer, SiteEvents } from './server.js';
import { startStub } from './stub.js';
import { tablesSourceFromEnv } from './tables.js';
import { Webinar } from './webinar.js';

const STUB_API_KEY = 'stub-key';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const config = loadDemoConfig();
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
    tables: tablesSourceFromEnv({
      mode: stub ? 'stub' : 'real',
      host: config.host,
      accountSlug: config.accountSlug,
    }),
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

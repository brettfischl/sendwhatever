export interface DemoConfig {
  port: number;
  host: string;
  /** Undefined means stub mode. */
  ingestUrl: string | undefined;
  ingestApiKey: string | undefined;
  /** Undefined means no X-Account-Slug header, for when a subdomain names the account. */
  accountSlug: string | undefined;
}

const DEFAULT_PORT = 3100;
export const DEFAULT_ACCOUNT_SLUG = 'demo';

export function loadDemoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const ingestUrl = env.INGEST_URL || undefined;
  const ingestApiKey = env.INGEST_API_KEY || undefined;

  if (ingestUrl) {
    if (!ingestApiKey) throw new Error('INGEST_URL is set, so INGEST_API_KEY must be set too.');
    assertSafeToDisplay(ingestUrl);
  }

  return {
    port: parsePort(env.DEMO_PORT),
    host: env.DEMO_HOST || '127.0.0.1',
    ingestUrl,
    ingestApiKey,
    // Set but empty is how to turn the header off.
    accountSlug: (env.ACCOUNT_SLUG ?? DEFAULT_ACCOUNT_SLUG) || undefined,
  };
}

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`DEMO_PORT must be a port number, not "${value}".`);
  }
  return port;
}

/** The URL appears in the request log in the browser, so it can't carry a secret. */
function assertSafeToDisplay(ingestUrl: string): void {
  let url: URL;
  try {
    url = new URL(ingestUrl);
  } catch {
    throw new Error('INGEST_URL is not a valid URL.');
  }
  if (url.search || url.username || url.password) {
    throw new Error('INGEST_URL must not contain a query or credentials. Use INGEST_API_KEY.');
  }
}

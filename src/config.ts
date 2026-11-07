import { fileURLToPath } from 'node:url';

export interface Config {
  appDatabaseUrl: string;
  dataDatabaseUrl: string;
  /** POSTGRES_PORT, for the default store connection. */
  postgresPort: number;
  /** Password of the sw_data role, for the default store credentials. */
  dataDbPassword: string;
  /** AES-256 key (32 bytes) that encrypts stored store credentials. */
  encryptionKey: Buffer;
  port: number;
  /** Defaults to loopback: internal routes have no auth. */
  host: string;
  /** Bearer token for the adapter and quarantine routes. Undefined means they refuse every request. */
  internalApiToken: string | undefined;
  /** Seed for the first super admin; both optional. */
  adminEmail: string | undefined;
  adminPassword: string | undefined;
  /** Limits the worker to one account's jobs. Undefined means every account. */
  workerAccountId: string | undefined;
  /** Undefined until a key is set. Code that calls the LLM should fail with a clear error. */
  fireworksApiKey: string | undefined;
  fireworksModel: string;
  /** Reasoning counts against max_tokens, and off is faster and cheaper with no visible loss (§12.1). */
  fireworksReasoningEffort: string;
  /**
   * The origin customers reach this server at, such as https://app.example.com, with no trailing slash
   * (§21.3). Shown on admin pages, and the only Origin the admin's CSRF check accepts. Undefined means
   * local mode: pages show localhost, and the check compares with the request URL.
   */
  publicBaseUrl: string | undefined;
  /** The Postgres host shown to customers. Undefined means localhost. Set, it adds `?sslmode=require`. */
  publicDbHost: string | undefined;
  /** The Postgres port shown to customers. Undefined means POSTGRES_PORT. */
  publicDbPort: number | undefined;
}

const DEFAULT_FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';

const DEFAULT_FIREWORKS_REASONING_EFFORT = 'none';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

/** Reads .env from the repo root. Variables already set in the environment take precedence. */
export function loadConfig(): Config {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const port = required('POSTGRES_PORT');
  const url = (role: string, password: string, database: string) =>
    `postgres://${role}:${encodeURIComponent(password)}@localhost:${port}/${database}`;

  return {
    appDatabaseUrl: url('sw_app', required('SW_APP_DB_PASSWORD'), 'sw_app'),
    dataDatabaseUrl: url('sw_data', required('SW_DATA_DB_PASSWORD'), 'postgres'),
    postgresPort: Number(port),
    dataDbPassword: required('SW_DATA_DB_PASSWORD'),
    encryptionKey: parseEncryptionKey(required('SW_ENCRYPTION_KEY')),
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '127.0.0.1',
    internalApiToken: process.env.INTERNAL_API_TOKEN || undefined,
    adminEmail: process.env.ADMIN_EMAIL || undefined,
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
    workerAccountId: process.env.WORKER_ACCOUNT_ID || undefined,
    fireworksApiKey: process.env.FIREWORKS_API_KEY || undefined,
    fireworksModel: process.env.FIREWORKS_MODEL || DEFAULT_FIREWORKS_MODEL,
    fireworksReasoningEffort: process.env.FIREWORKS_REASONING_EFFORT || DEFAULT_FIREWORKS_REASONING_EFFORT,
    publicBaseUrl: parsePublicBaseUrl(process.env.PUBLIC_BASE_URL || undefined),
    publicDbHost: parsePublicDbHost(process.env.PUBLIC_DB_HOST || undefined),
    publicDbPort: parsePublicDbPort(process.env.PUBLIC_DB_PORT || undefined),
  };
}

// The messages below never echo the value, in case someone pastes a URL with credentials in it.

/** An http(s) origin with nothing after it, since the app's routes live at the root. */
export function parsePublicBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const fail = () => {
    throw new Error(
      'PUBLIC_BASE_URL must be an http or https origin, such as https://app.example.com, with no path, query, or credentials.',
    );
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail();
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail();
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail();
  // `new URL` accepts '?' and '#' with nothing after them; the origin would drop them silently.
  if (/[?#]/.test(value)) fail();
  return url.origin;
}

/** A hostname or IPv4 address: it goes into a connection string as is. */
export function parsePublicDbHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const label = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  if (value.length > 253 || !value.split('.').every((part) => label.test(part))) {
    throw new Error('PUBLIC_DB_HOST must be a hostname or IPv4 address, such as db.example.com.');
  }
  return value;
}

export function parsePublicDbPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error('PUBLIC_DB_PORT must be a port number from 1 to 65535.');
  }
  return port;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run npm run setup to create it in .env.`);
  return value;
}

function parseEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('SW_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  return key;
}

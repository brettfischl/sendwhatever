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
}

const DEFAULT_FIREWORKS_MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

/** Reads .env from the repo root. Variables already set in the environment take precedence. */
export function loadConfig(): Config {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const port = required('POSTGRES_PORT');
  const url = (role: string, password: string) =>
    `postgres://${role}:${encodeURIComponent(password)}@localhost:${port}/${role}`;

  return {
    appDatabaseUrl: url('sw_app', required('SW_APP_DB_PASSWORD')),
    dataDatabaseUrl: url('sw_data', required('SW_DATA_DB_PASSWORD')),
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
  };
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

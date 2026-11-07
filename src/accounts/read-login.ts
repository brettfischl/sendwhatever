import { decryptJson } from '../secrets.js';
import type { AppDeps } from '../http/deps.js';

export interface ReadLogin {
  user: string;
  password: string;
  database: string;
  host: string;
  port: number;
}

/**
 * The read-only login of the account's active store, or undefined when there isn't one yet.
 * Local mode only: the host is localhost and the port is the dev Postgres port.
 */
export async function loadAccountReadLogin(
  { appDb, config }: Pick<AppDeps, 'appDb' | 'config'>,
  accountId: string,
): Promise<ReadLogin | undefined> {
  const row = (
    await appDb.query<{ read_credentials: Buffer | null }>(
      `SELECT read_credentials FROM account_stores
        WHERE account_id = $1 AND status = 'active'`,
      [accountId],
    )
  ).rows[0];
  if (!row?.read_credentials) return undefined;
  const creds = decryptJson(config.encryptionKey, row.read_credentials);
  return {
    user: String(creds.user),
    password: String(creds.password),
    database: String(creds.database),
    host: 'localhost',
    port: config.postgresPort,
  };
}

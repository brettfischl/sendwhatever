import { decryptJson } from '../secrets.js';
import { publicDbAddress, type PublicDbAddress } from '../admin/public-addresses.js';
import type { AppDeps } from '../http/deps.js';

export interface ReadLogin extends PublicDbAddress {
  user: string;
  password: string;
  database: string;
}

/**
 * The read-only login of the account's active store, or undefined when there isn't one yet.
 * The host and port are the public ones customers connect to, not the store's own connection.
 */
export async function loadAccountReadLogin(
  { appDb, config }: Pick<AppDeps, 'appDb' | 'config'>,
  accountId: string,
): Promise<ReadLogin | undefined> {
  const row = (
    await appDb.query<{ read_credentials: Buffer | null; connection: { host: unknown; port: unknown } }>(
      `SELECT read_credentials, connection FROM account_stores
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
    ...publicDbAddress(config, row.connection),
  };
}

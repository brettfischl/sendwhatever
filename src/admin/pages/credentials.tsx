import type { Context, Handler } from 'hono';
import { HttpError } from '../../http/deps.js';
import { decryptJson, generateApiKey, hashApiKey } from '../../secrets.js';
import { CopyBlock, Form, Layout } from '../views.js';
import type { AdminEnv } from '../index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
export async function loadReadLogin(c: Context<AdminEnv>): Promise<ReadLogin | undefined> {
  const { appDb, config } = c.get('deps');
  const row = (
    await appDb.query<{ read_credentials: Buffer | null }>(
      `SELECT read_credentials FROM account_stores
        WHERE account_id = $1 AND status = 'active'`,
      [c.get('account')!.id],
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

/** The connection string, with the password only when asked for. */
export function connectionString(login: ReadLogin, withPassword: boolean): string {
  const auth = withPassword
    ? `${encodeURIComponent(login.user)}:${encodeURIComponent(login.password)}`
    : encodeURIComponent(login.user);
  return `postgres://${auth}@${login.host}:${login.port}/${encodeURIComponent(login.database)}`;
}

interface KeyRow {
  id: string;
  short: string;
  created_at: Date;
  revoked_at: Date | null;
}

export const credentialsPage: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { rows } = await c.get('deps').appDb.query<KeyRow>(
    `SELECT id, left(key_hash, 8) AS short, created_at, revoked_at
       FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC, id`,
    [account.id],
  );
  const base = `/admin/accounts/${account.id}/credentials`;
  const csrf = c.get('csrf');

  return c.html(
    <Layout title="Credentials" user={c.get('user')} csrf={csrf}>
      <section class="card">
        <h1>Credentials: {account.slug}</h1>
        <p class="muted">
          <a href={`/admin/accounts/${account.id}`}>Back to {account.slug}</a> ·{' '}
          <a href={`/admin/accounts/${account.id}/connect`}>Connect</a>
        </p>
      </section>
      <section class="card">
        <h2>API keys</h2>
        {rows.length === 0 ? (
          <p class="muted">No API keys yet.</p>
        ) : (
          <ul class="list">
            {rows.map((key) => (
              <li>
                <span>
                  <code>{key.short}</code>{' '}
                  <span class="muted">created {key.created_at.toISOString()}</span>
                </span>
                {key.revoked_at ? (
                  <span class="tag">revoked {key.revoked_at.toISOString()}</span>
                ) : (
                  !account.readOnly && (
                    <Form action={`${base}/keys/${key.id}/revoke`} csrf={csrf}>
                      <button class="quiet" type="submit">
                        Revoke
                      </button>
                    </Form>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
        {!account.readOnly && (
          <Form action={`${base}/keys`} csrf={csrf}>
            <button type="submit">Create API key</button>
          </Form>
        )}
      </section>
      <section class="card">
        <h2>Read-only database login</h2>
        {account.readOnly ? (
          <p class="muted">
            Revealing this login requires account membership, and you aren't a member of {account.slug}.{' '}
            <a href={`/admin/manage/accounts/${account.id}`}>Add yourself on its management page</a>.
          </p>
        ) : (
          <>
            <p class="muted">Revealing the password is a deliberate action.</p>
            <Form action={`${base}/reveal`} csrf={csrf}>
              <button type="submit">Reveal login</button>
            </Form>
          </>
        )}
      </section>
    </Layout>,
  );
};

export const createKey: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const key = generateApiKey();
  await c.get('deps').appDb.query('INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2)', [
    account.id,
    hashApiKey(key),
  ]);
  // Rendered directly, never redirected, so the key cannot end up in a URL.
  return c.html(
    <Layout title="New API key" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>New API key</h1>
        <p class="error">Copy it now. It won't be shown again.</p>
        <CopyBlock value={key} label="API key" />
        <p>
          <a href={`/admin/accounts/${account.id}/credentials`}>Back to credentials</a>
        </p>
      </section>
    </Layout>,
  );
};

export const revokeKey: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const keyId = c.req.param('keyId');
  if (!keyId || !UUID.test(keyId)) throw new HttpError(404, 'Page not found');
  const { rowCount } = await c.get('deps').appDb.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND account_id = $2`,
    [keyId, account.id],
  );
  if (!rowCount) throw new HttpError(404, 'Page not found');
  return c.redirect(`/admin/accounts/${account.id}/credentials`, 303);
};

export const revealLogin: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const login = await loadReadLogin(c);
  if (!login) throw new HttpError(404, 'This account has no active store yet');
  return c.html(
    <Layout title="Read-only login" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Read-only database login</h1>
        <LoginDetails login={login} />
        <p>
          <a href={`/admin/accounts/${account.id}/credentials`}>Back to credentials</a>
        </p>
      </section>
    </Layout>,
  );
};

const LoginDetails = ({ login }: { login: ReadLogin }) => (
  <>
    <ul class="list">
      <li>
        User <code>{login.user}</code>
      </li>
      <li>
        Password <CopyBlock value={login.password} label="password" />
      </li>
      <li>
        Database <code>{login.database}</code>
      </li>
      <li>
        Host <code>{login.host}</code>
      </li>
      <li>
        Port <code>{String(login.port)}</code>
      </li>
    </ul>
    <p>Connection string</p>
    <CopyBlock value={connectionString(login, true)} label="connection string" />
  </>
);

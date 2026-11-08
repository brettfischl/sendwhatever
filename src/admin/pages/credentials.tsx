import type { Context, Handler } from 'hono';
import { HttpError } from '../../http/deps.js';
import { createApiKey } from '../../accounts/api-keys.js';
import { loadAccountReadLogin, type ReadLogin } from '../../accounts/read-login.js';
import { Form, Layout } from '../views.js';
import type { AdminEnv } from '../index.js';
import { timestamp } from './format.js';
import {
  Button,
  Callout,
  CodeBlock,
  DataTable,
  EmptyState,
  LinkButton,
  PageHeader,
  Section,
  StatusPill,
} from '../ui/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The read-only login of the current account's active store, or undefined when there isn't one yet. */
export function loadReadLogin(c: Context<AdminEnv>): Promise<ReadLogin | undefined> {
  return loadAccountReadLogin(c.get('deps'), c.get('account')!.id);
}

/** The connection string, with the password only when asked for. */
export function connectionString(login: ReadLogin, withPassword: boolean): string {
  const auth = withPassword
    ? `${encodeURIComponent(login.user)}:${encodeURIComponent(login.password)}`
    : encodeURIComponent(login.user);
  const ssl = login.requireSsl ? '?sslmode=require' : '';
  return `postgres://${auth}@${login.host}:${login.port}/${encodeURIComponent(login.database)}${ssl}`;
}

interface KeyRow {
  id: string;
  short: string;
  scope: 'ingest' | 'read';
  created_at: Date;
  revoked_at: Date | null;
}

/** Accounts > slug > Credentials, optionally with a final crumb for a result page. */
const credentialsCrumbs = (account: { id: string; slug: string }, last?: string) => [
  { label: 'Accounts', href: '/admin' },
  { label: account.slug, href: `/admin/accounts/${account.id}` },
  last
    ? { label: 'Credentials', href: `/admin/accounts/${account.id}/credentials` }
    : { label: 'Credentials' },
  ...(last ? [{ label: last }] : []),
];

export const credentialsPage: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { rows } = await c.get('deps').appDb.query<KeyRow>(
    `SELECT id, left(key_hash, 8) AS short, scope, created_at, revoked_at
       FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC, id`,
    [account.id],
  );
  const base = `/admin/accounts/${account.id}/credentials`;
  const csrf = c.get('csrf');

  return c.html(
    <Layout title="Credentials" user={c.get('user')} csrf={csrf}>
      <PageHeader
        breadcrumbs={credentialsCrumbs(account)}
        title="Credentials"
        description="Create and revoke API keys, and get your read-only database login."
        actions={
          !account.readOnly && (
            <>
              <Form action={`${base}/keys`} csrf={csrf}>
                <input type="hidden" name="scope" value="read" />
                <Button variant="secondary" icon="plus">
                  Create read-only API key
                </Button>
              </Form>
              <Form action={`${base}/keys`} csrf={csrf}>
                <Button icon="plus">Create API key</Button>
              </Form>
            </>
          )
        }
      />
      {account.readOnly && (
        <Callout variant="info">
          Super admins have read-only access to accounts, so you can't create or revoke keys here. A member of{' '}
          {account.slug} must do that.
        </Callout>
      )}
      <Section
        title="API keys"
        description={
          <>
            API keys send data to <code>/ingest</code>. Read-only keys read rows from <code>/tables</code>, and
            neither can do the other's job.
          </>
        }
        flush
      >
        <DataTable
          rows={rows}
          caption="API keys"
          empty={
            <EmptyState
              icon="key"
              title="No API keys yet."
              description={
                account.readOnly
                  ? 'A member of this account can create one.'
                  : 'Create a key to start sending data.'
              }
            />
          }
          columns={[
            { header: 'Key', mono: true, cell: (key) => key.short },
            {
              header: 'Scope',
              cell: (key) => (
                <StatusPill variant={key.scope === 'read' ? 'info' : 'neutral'} dot={false}>
                  {key.scope === 'read' ? 'read-only' : 'ingest'}
                </StatusPill>
              ),
            },
            { header: 'Created', cell: (key) => timestamp(key.created_at) },
            {
              header: 'Status',
              cell: (key) =>
                key.revoked_at ? (
                  <StatusPill variant="neutral">revoked {timestamp(key.revoked_at)}</StatusPill>
                ) : (
                  <StatusPill variant="success">active</StatusPill>
                ),
            },
            {
              header: <span class="visually-hidden">Actions</span>,
              align: 'right',
              cell: (key) =>
                !key.revoked_at &&
                !account.readOnly && (
                  <Form action={`${base}/keys/${key.id}/revoke`} csrf={csrf}>
                    <Button variant="secondary" size="sm">
                      Revoke
                    </Button>
                  </Form>
                ),
            },
          ]}
        />
      </Section>
      <Section title="Read-only database login" description="Connect with any Postgres client to read your data.">
        {account.readOnly ? (
          <Callout variant="info">
            Revealing this login requires account membership, and you aren't a member of {account.slug}.{' '}
            <a href={`/admin/manage/accounts/${account.id}`}>Add yourself on its management page</a>.
          </Callout>
        ) : (
          <>
            <p class="muted">Revealing the password is a deliberate action.</p>
            <Form action={`${base}/reveal`} csrf={csrf}>
              <Button variant="secondary" icon="key">
                Reveal login
              </Button>
            </Form>
          </>
        )}
      </Section>
    </Layout>,
  );
};

export const createKey: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { scope: requested } = await c.req.parseBody();
  const scope = requested === 'read' ? 'read' : 'ingest';
  const title = scope === 'read' ? 'New read-only API key' : 'New API key';
  const key = await createApiKey(c.get('deps').appDb, account.id, scope);
  // Rendered directly, never redirected, so the key cannot end up in a URL.
  return c.html(
    <Layout title={title} user={c.get('user')} csrf={c.get('csrf')}>
      <PageHeader
        breadcrumbs={credentialsCrumbs(account, title)}
        title={title}
        description="Send this key with your requests to authenticate them."
        actions={
          <LinkButton href={`/admin/accounts/${account.id}/credentials`} icon="chevron-left">
            Back to credentials
          </LinkButton>
        }
      />
      <Callout variant="warning" title="Copy it now">
        It won't be shown again.
      </Callout>
      <Section title="API key">
        <CodeBlock value={key} label="API key" />
      </Section>
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
      <PageHeader
        breadcrumbs={credentialsCrumbs(account, 'Read-only login')}
        title="Read-only database login"
        description="Use these details in any Postgres client."
        actions={
          <LinkButton href={`/admin/accounts/${account.id}/credentials`} icon="chevron-left">
            Back to credentials
          </LinkButton>
        }
      />
      <Callout variant="info">
        This login includes the database password. Keep it somewhere safe. You can reveal it again from
        Credentials.
      </Callout>
      <LoginDetails login={login} />
    </Layout>,
  );
};

const LoginDetails = ({ login }: { login: ReadLogin }) => (
  <>
    <Section title="Login" flush>
      <DataTable
        caption="Login details"
        rows={[
          { label: 'User', value: <code>{login.user}</code> },
          { label: 'Password', value: <CodeBlock value={login.password} label="password" /> },
          { label: 'Database', value: <code>{login.database}</code> },
          { label: 'Host', value: <code>{login.host}</code> },
          { label: 'Port', value: <code>{String(login.port)}</code> },
          ...(login.requireSsl ? [{ label: 'SSL mode', value: <code>require</code> }] : []),
        ]}
        columns={[
          { header: 'Field', width: '140px', cell: (r) => r.label },
          { header: 'Value', cell: (r) => r.value },
        ]}
      />
    </Section>
    <Section title="Connection string">
      <CodeBlock value={connectionString(login, true)} label="connection string" />
    </Section>
  </>
);

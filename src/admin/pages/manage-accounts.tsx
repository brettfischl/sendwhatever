import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import { AccountError, createAccount, type CreatedAccount } from '../../accounts/create.js';
import { HttpError } from '../../http/deps.js';
import type { AdminEnv } from '../index.js';
import { publicDbAddress, type PublicDbAddress } from '../public-addresses.js';
import type { SessionUser } from '../sessions.js';
import {
  accountStatusVariant,
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
import { Form, Layout } from '../views.js';
import { dateOnly } from './format.js';

type Ctx = Context<AdminEnv>;
type Status = 200 | 400 | 404 | 409 | 503;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_ERRORS: Record<string, { status: Status; message: string }> = {
  invalid_slug: {
    status: 400,
    message:
      'Invalid slug. Use one lowercase DNS label: letters, digits and hyphens, no leading or trailing hyphen, up to 63 characters.',
  },
  invalid_storage: { status: 400, message: 'The storage settings are invalid.' },
  exists: { status: 409, message: 'An account with that slug already exists.' },
  provision_unavailable: {
    status: 503,
    message:
      'Storage is temporarily unavailable. Try again in a moment; the retry resumes the same account.',
  },
  provision_failed: { status: 503, message: 'Storage provisioning failed. Check the server log.' },
};

interface AccountRow {
  id: string;
  slug: string;
  status: string;
  created_at: Date;
  member_count: number;
}
interface MemberRow {
  id: string;
  email: string;
  disabled_at: Date | null;
}
interface AccountDetail {
  id: string;
  slug: string;
  status: string;
  created_at: Date;
}

const MANAGE_ACCOUNTS = { label: 'Accounts', href: '/admin/manage/accounts' };

const AccountsListPage: FC<{
  user: SessionUser;
  csrf: string;
  accounts: AccountRow[];
  error?: string;
  slug?: string;
}> = ({ user, csrf, accounts, error, slug }) => (
  <Layout title="Manage accounts" user={user} csrf={csrf}>
    <PageHeader
      breadcrumbs={[{ label: 'Manage' }, { label: 'Accounts' }]}
      title="Manage accounts"
      description="Create accounts, disable them, and choose who is a member."
      actions={
        <LinkButton href="#create-account" variant="primary" icon="plus">
          Create account
        </LinkButton>
      }
    />
    {error && <Callout variant="danger">{error}</Callout>}
    <Section title="Accounts" flush>
      <DataTable
        rows={accounts}
        caption="Accounts"
        empty={
          <EmptyState
            icon="building"
            title="There are no accounts yet."
            description="Create the first account below."
          />
        }
        columns={[
          { header: 'Account', cell: (a) => <a href={`/admin/manage/accounts/${a.id}`}>{a.slug}</a> },
          {
            header: 'Status',
            width: '160px',
            cell: (a) => <StatusPill variant={accountStatusVariant(a.status)}>{a.status}</StatusPill>,
          },
          { header: 'Created', cell: (a) => dateOnly(a.created_at) },
          {
            header: 'Members',
            align: 'right',
            cell: (a) => `${a.member_count} member${a.member_count === 1 ? '' : 's'}`,
          },
        ]}
      />
    </Section>
    <Section title="Create an account" id="create-account">
      <Form action="/admin/manage/accounts" csrf={csrf} class="form narrow">
        <label>
          Slug
          <input type="text" name="slug" value={slug ?? ''} required />
        </label>
        <Button>Create account</Button>
      </Form>
    </Section>
  </Layout>
);

// `db` replaces created.database's host and port, which are the store's own connection.
const AccountCreatedPage: FC<{
  user: SessionUser;
  csrf: string;
  created: CreatedAccount;
  db: PublicDbAddress;
}> = ({ user, csrf, created, db }) => (
  <Layout title="Account created" user={user} csrf={csrf}>
    <PageHeader
      breadcrumbs={[{ label: 'Manage' }, MANAGE_ACCOUNTS, { label: created.slug }]}
      title={`Account ${created.slug} created`}
      description="Save the API key before you leave this page."
      actions={
        <LinkButton href={`/admin/manage/accounts/${created.accountId}`} icon="chevron-right">
          Go to the account
        </LinkButton>
      }
    />
    <Callout variant="warning" title="Copy it now">
      The API key is shown once and cannot be shown again, so copy it now. Members of the account can reveal the
      read-only database login later on its Credentials page.
    </Callout>
    <Section title="API key">
      <CodeBlock value={created.apiKey} label="API key" />
    </Section>
    <Section title="Read-only database login" flush>
      <DataTable
        caption="Login details"
        rows={[
          { label: 'Host', value: <code>{db.host}</code> },
          { label: 'Port', value: <code>{String(db.port)}</code> },
          ...(db.requireSsl ? [{ label: 'SSL mode', value: <code>require</code> }] : []),
          { label: 'Database', value: <code>{String(created.database.database)}</code> },
          { label: 'User', value: <code>{String(created.database.user)}</code> },
          {
            label: 'Password',
            value: <CodeBlock value={String(created.database.password)} label="password" />,
          },
        ]}
        columns={[
          { header: 'Field', width: '140px', cell: (r) => r.label },
          { header: 'Value', cell: (r) => r.value },
        ]}
      />
    </Section>
  </Layout>
);

const AccountDetailPage: FC<{
  user: SessionUser;
  csrf: string;
  account: AccountDetail;
  members: MemberRow[];
  error?: string;
}> = ({ user, csrf, account, members, error }) => {
  const base = `/admin/manage/accounts/${account.id}`;
  return (
    <Layout title={account.slug} user={user} csrf={csrf}>
      <PageHeader
        breadcrumbs={[{ label: 'Manage' }, MANAGE_ACCOUNTS, { label: account.slug }]}
        title={
          <>
            {account.slug}
            <StatusPill variant={accountStatusVariant(account.status)}>{account.status}</StatusPill>
          </>
        }
        description={`Created ${dateOnly(account.created_at)}.`}
        actions={
          <>
            <LinkButton href={`/admin/accounts/${account.id}`} icon="external-link">
              Open the account's pages
            </LinkButton>
            {account.status === 'active' && (
              <Form action={`${base}/disable`} csrf={csrf}>
                <Button variant="danger">Disable account</Button>
              </Form>
            )}
            {account.status === 'disabled' && (
              <Form action={`${base}/enable`} csrf={csrf}>
                <Button variant="secondary">Re-enable account</Button>
              </Form>
            )}
          </>
        }
      />
      {error && <Callout variant="danger">{error}</Callout>}
      {account.status === 'provisioning' && (
        <Callout variant="info">Still provisioning. It cannot be disabled until it is active.</Callout>
      )}
      <Section title="Members" flush>
        <DataTable
          rows={members}
          caption="Members"
          empty={<EmptyState icon="users" title="No members." description="Add a member below." />}
          columns={[
            {
              header: 'Email',
              cell: (m) => (
                <>
                  {m.email}
                  {m.disabled_at && <StatusPill variant="neutral">disabled</StatusPill>}
                </>
              ),
            },
            {
              header: <span class="visually-hidden">Actions</span>,
              align: 'right',
              cell: (m) => (
                <Form action={`${base}/members/${m.id}/remove`} csrf={csrf}>
                  <Button variant="secondary" size="sm">
                    Remove
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Section>
      <Section title="Add a member">
        <Form action={`${base}/members`} csrf={csrf} class="form narrow">
          <label>
            User email
            <input type="email" name="email" required />
          </label>
          <Button>Add member</Button>
        </Form>
      </Section>
    </Layout>
  );
};

async function renderList(c: Ctx, status: Status, error?: string, slug?: string) {
  const { rows } = await c.get('deps').appDb.query<AccountRow>(
    `SELECT a.id, a.slug, a.status, a.created_at,
            (SELECT count(*)::int FROM account_members m WHERE m.account_id = a.id) AS member_count
       FROM accounts a ORDER BY a.slug`,
  );
  return c.html(
    <AccountsListPage
      user={c.get('user')!}
      csrf={c.get('csrf')!}
      accounts={rows}
      error={error}
      slug={slug}
    />,
    status,
  );
}

async function renderDetail(c: Ctx, id: string, status: Status = 200, error?: string) {
  const { appDb } = c.get('deps');
  const account = (
    await appDb.query<AccountDetail>(
      'SELECT id, slug, status, created_at FROM accounts WHERE id = $1',
      [id],
    )
  ).rows[0];
  if (!account) throw new HttpError(404, 'Page not found');
  const members = (
    await appDb.query<MemberRow>(
      `SELECT u.id, u.email, u.disabled_at FROM account_members m
         JOIN users u ON u.id = m.user_id WHERE m.account_id = $1 ORDER BY lower(u.email)`,
      [id],
    )
  ).rows;
  return c.html(
    <AccountDetailPage
      user={c.get('user')!}
      csrf={c.get('csrf')!}
      account={account}
      members={members}
      error={error}
    />,
    status,
  );
}

function accountId(c: Ctx): string {
  const id = c.req.param('accountId');
  if (!id || !UUID.test(id)) throw new HttpError(404, 'Page not found');
  return id;
}

export const manageAccountRoutes = new Hono<AdminEnv>();

manageAccountRoutes.get('/', (c) => renderList(c, 200));

manageAccountRoutes.post('/', async (c) => {
  const body = await c.req.parseBody();
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  try {
    const created = await createAccount(c.get('deps'), { slug });
    // Rendered in this response only. Never redirect with the secrets.
    return c.html(
      <AccountCreatedPage
        user={c.get('user')!}
        csrf={c.get('csrf')!}
        created={created}
        db={publicDbAddress(c.get('deps').config, created.database)}
      />,
    );
  } catch (error) {
    if (error instanceof AccountError) {
      const mapped = ACCOUNT_ERRORS[error.code] ?? { status: 400 as Status, message: error.message };
      return renderList(c, mapped.status, mapped.message, slug);
    }
    throw error;
  }
});

manageAccountRoutes.get('/:accountId', (c) => renderDetail(c, accountId(c)));

async function setStatus(c: Ctx, from: 'active' | 'disabled', to: 'active' | 'disabled') {
  const id = accountId(c);
  const { appDb } = c.get('deps');
  const { rowCount } = await appDb.query(
    'UPDATE accounts SET status = $3 WHERE id = $1 AND status = $2',
    [id, from, to],
  );
  if (rowCount) return c.redirect(`/admin/manage/accounts/${id}`, 303);
  const row = (
    await appDb.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [id])
  ).rows[0];
  if (!row) throw new HttpError(404, 'Page not found');
  if (row.status === to) return c.redirect(`/admin/manage/accounts/${id}`, 303);
  return renderDetail(c, id, 409, `The account is ${row.status}, so it cannot be set to ${to} from here.`);
}

manageAccountRoutes.post('/:accountId/disable', (c) => setStatus(c, 'active', 'disabled'));
manageAccountRoutes.post('/:accountId/enable', (c) => setStatus(c, 'disabled', 'active'));

manageAccountRoutes.post('/:accountId/members', async (c) => {
  const id = accountId(c);
  const { appDb } = c.get('deps');
  const body = await c.req.parseBody();
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const exists = await appDb.query('SELECT 1 FROM accounts WHERE id = $1', [id]);
  if (!exists.rowCount) throw new HttpError(404, 'Page not found');
  const user = email
    ? (
        await appDb.query<{ id: string; disabled_at: Date | null }>(
          'SELECT id, disabled_at FROM users WHERE lower(email) = lower($1)',
          [email],
        )
      ).rows[0]
    : undefined;
  if (!user) return renderDetail(c, id, 400, 'No user has that email. Create the user first.');
  if (user.disabled_at) return renderDetail(c, id, 400, 'That user is disabled.');
  await appDb.query(
    'INSERT INTO account_members (account_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [id, user.id],
  );
  return c.redirect(`/admin/manage/accounts/${id}`, 303);
});

manageAccountRoutes.post('/:accountId/members/:userId/remove', async (c) => {
  const id = accountId(c);
  const userId = c.req.param('userId');
  if (!UUID.test(userId)) throw new HttpError(404, 'Page not found');
  await c
    .get('deps')
    .appDb.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [id, userId]);
  return c.redirect(`/admin/manage/accounts/${id}`, 303);
});

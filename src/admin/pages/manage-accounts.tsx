import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import { AccountError, createAccount, type CreatedAccount } from '../../accounts/create.js';
import { HttpError } from '../../http/deps.js';
import type { AdminEnv } from '../index.js';
import { publicDbAddress, type PublicDbAddress } from '../public-addresses.js';
import type { SessionUser } from '../sessions.js';
import { CopyBlock, Form, Layout } from '../views.js';

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

const ManageNav: FC = () => (
  <p class="muted">
    <a href="/admin/manage/accounts">Accounts</a> | <a href="/admin/manage/users">Users</a>
  </p>
);

const date = (d: Date) => d.toISOString().slice(0, 10);

const AccountsListPage: FC<{
  user: SessionUser;
  csrf: string;
  accounts: AccountRow[];
  error?: string;
  slug?: string;
}> = ({ user, csrf, accounts, error, slug }) => (
  <Layout title="Manage accounts" user={user} csrf={csrf}>
    <section class="card">
      <h1>Manage accounts</h1>
      <ManageNav />
      {accounts.length === 0 ? (
        <p class="muted">There are no accounts yet.</p>
      ) : (
        <ul class="list">
          {accounts.map((a) => (
            <li>
              <a href={`/admin/manage/accounts/${a.id}`}>{a.slug}</a>
              <span class="muted">
                created {date(a.created_at)}, {a.member_count} member{a.member_count === 1 ? '' : 's'}
              </span>
              <span class={`tag ${a.status}`}>{a.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
    <section class="card narrow">
      <h2>Create an account</h2>
      {error && <p class="error">{error}</p>}
      <Form action="/admin/manage/accounts" csrf={csrf} class="form">
        <label>
          Slug
          <input type="text" name="slug" value={slug ?? ''} required />
        </label>
        <button type="submit">Create account</button>
      </Form>
    </section>
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
    <section class="card">
      <h1>Account {created.slug} created</h1>
      <p class="error">
        The API key is shown once and cannot be shown again, so copy it now. Members of the account can reveal the read-only database login later on its Credentials page.
      </p>
      <h2>API key</h2>
      <CopyBlock value={created.apiKey} label="API key" />
      <h2>Read-only database login</h2>
      <ul class="list">
        <li>
          Host <code>{db.host}</code>
        </li>
        <li>
          Port <code>{String(db.port)}</code>
        </li>
        {db.requireSsl && (
          <li>
            SSL mode <code>require</code>
          </li>
        )}
        <li>
          Database <code>{String(created.database.database)}</code>
        </li>
        <li>
          User <code>{String(created.database.user)}</code>
        </li>
        <li>
          Password <CopyBlock value={String(created.database.password)} label="password" />
        </li>
      </ul>
      <p>
        <a href={`/admin/manage/accounts/${created.accountId}`}>Go to the account</a>
      </p>
    </section>
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
      <section class="card">
        <h1>{account.slug}</h1>
        <ManageNav />
        <p>
          <span class={`tag ${account.status}`}>{account.status}</span>{' '}
          <span class="muted">created {date(account.created_at)}</span>
        </p>
        {error && <p class="error">{error}</p>}
        {account.status === 'active' && (
          <Form action={`${base}/disable`} csrf={csrf}>
            <button class="quiet" type="submit">
              Disable account
            </button>
          </Form>
        )}
        {account.status === 'disabled' && (
          <Form action={`${base}/enable`} csrf={csrf}>
            <button class="quiet" type="submit">
              Re-enable account
            </button>
          </Form>
        )}
        {account.status === 'provisioning' && (
          <p class="muted">Still provisioning. It cannot be disabled until it is active.</p>
        )}
        <p>
          <a href={`/admin/accounts/${account.id}`}>Open the account's pages</a>
        </p>
      </section>
      <section class="card">
        <h2>Members</h2>
        {members.length === 0 ? (
          <p class="muted">No members.</p>
        ) : (
          <ul class="list">
            {members.map((m) => (
              <li>
                <span>
                  {m.email}
                  {m.disabled_at ? ' (disabled)' : ''}
                </span>
                <Form action={`${base}/members/${m.id}/remove`} csrf={csrf}>
                  <button class="quiet" type="submit">
                    Remove
                  </button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section class="card narrow">
        <h2>Add a member</h2>
        <Form action={`${base}/members`} csrf={csrf} class="form">
          <label>
            User email
            <input type="email" name="email" required />
          </label>
          <button type="submit">Add member</button>
        </Form>
      </section>
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

import { Hono, type Context } from 'hono';
import type { FC } from 'hono/jsx';
import { HttpError } from '../../http/deps.js';
import type { AdminEnv } from '../index.js';
import type { SessionUser } from '../sessions.js';
import { MIN_PASSWORD_LENGTH, UserError, createUser, disableUser, setPassword } from '../users.js';
import { Form, Layout } from '../views.js';

type Ctx = Context<AdminEnv>;
type Status = 200 | 400 | 409;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_ERRORS: Record<UserError['code'], { status: Status; message: string }> = {
  invalid_email: { status: 400, message: 'That email address is not valid.' },
  weak_password: {
    status: 400,
    message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  },
  email_taken: { status: 409, message: 'A user with that email already exists.' },
};

interface UserRow {
  id: string;
  email: string;
  is_super_admin: boolean;
  disabled_at: Date | null;
  account_count: number;
}

const UsersPage: FC<{
  user: SessionUser;
  csrf: string;
  users: UserRow[];
  error?: string;
  email?: string;
}> = ({ user, csrf, users, error, email }) => (
  <Layout title="Manage users" user={user} csrf={csrf}>
    <section class="card">
      <h1>Manage users</h1>
      <p class="muted">
        <a href="/admin/manage/accounts">Accounts</a> | <a href="/admin/manage/users">Users</a>
      </p>
      {error && <p class="error">{error}</p>}
      <ul class="list">
        {users.map((u) => (
          <li>
            <span>
              {u.email}
              {u.is_super_admin && <span class="tag">super admin</span>}
              {u.disabled_at && (
                <span class="tag">disabled {u.disabled_at.toISOString().slice(0, 10)}</span>
              )}
            </span>
            <span class="muted">
              {u.account_count} account{u.account_count === 1 ? '' : 's'}
            </span>
            {!u.disabled_at && (
              <Form action={`/admin/manage/users/${u.id}/disable`} csrf={csrf}>
                <button class="quiet" type="submit">
                  Disable
                </button>
              </Form>
            )}
            <Form action={`/admin/manage/users/${u.id}/password`} csrf={csrf}>
              <input
                type="password"
                name="password"
                placeholder="New password"
                autocomplete="new-password"
                required
              />
              <button class="quiet" type="submit">
                Reset password
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </section>
    <section class="card narrow">
      <h2>Create a user</h2>
      <Form action="/admin/manage/users" csrf={csrf} class="form">
        <label>
          Email
          <input type="email" name="email" value={email ?? ''} required />
        </label>
        <label>
          Initial password (at least {MIN_PASSWORD_LENGTH} characters)
          <input type="password" name="password" autocomplete="new-password" required />
        </label>
        <button type="submit">Create user</button>
      </Form>
    </section>
  </Layout>
);

async function renderUsers(c: Ctx, status: Status, error?: string, email?: string) {
  const { rows } = await c.get('deps').appDb.query<UserRow>(
    `SELECT u.id, u.email, u.is_super_admin, u.disabled_at,
            (SELECT count(*)::int FROM account_members m WHERE m.user_id = u.id) AS account_count
       FROM users u ORDER BY lower(u.email)`,
  );
  return c.html(
    <UsersPage
      user={c.get('user')!}
      csrf={c.get('csrf')!}
      users={rows}
      error={error}
      email={email}
    />,
    status,
  );
}

function userId(c: Ctx): string {
  const id = c.req.param('userId');
  if (!id || !UUID.test(id)) throw new HttpError(404, 'Page not found');
  return id;
}

async function requireUser(c: Ctx, id: string) {
  const found = await c.get('deps').appDb.query('SELECT 1 FROM users WHERE id = $1', [id]);
  if (!found.rowCount) throw new HttpError(404, 'Page not found');
}

export const manageUserRoutes = new Hono<AdminEnv>();

manageUserRoutes.get('/', (c) => renderUsers(c, 200));

manageUserRoutes.post('/', async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  try {
    await createUser(c.get('deps').appDb, { email, password });
  } catch (error) {
    if (error instanceof UserError) {
      const mapped = USER_ERRORS[error.code];
      return renderUsers(c, mapped.status, mapped.message, email);
    }
    throw error;
  }
  return c.redirect('/admin/manage/users', 303);
});

manageUserRoutes.post('/:userId/disable', async (c) => {
  const id = userId(c);
  if (id === c.get('user')!.id) return renderUsers(c, 400, 'You cannot disable your own user.');
  await requireUser(c, id);
  await disableUser(c.get('deps').appDb, id);
  return c.redirect('/admin/manage/users', 303);
});

manageUserRoutes.post('/:userId/password', async (c) => {
  const id = userId(c);
  await requireUser(c, id);
  const body = await c.req.parseBody();
  const password = typeof body.password === 'string' ? body.password : '';
  try {
    await setPassword(c.get('deps').appDb, id, password);
  } catch (error) {
    if (error instanceof UserError) {
      const mapped = USER_ERRORS[error.code];
      return renderUsers(c, mapped.status, mapped.message);
    }
    throw error;
  }
  return c.redirect('/admin/manage/users', 303);
});

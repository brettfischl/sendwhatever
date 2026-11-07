import type { FC, PropsWithChildren } from 'hono/jsx';
import type { SessionUser } from './sessions.js';

// A small subset of demo/public/app.css, so the admin looks like the demo site.
const CSS = `
:root { --ink:#16202e; --muted:#5d6b7c; --line:#dfe4ea; --paper:#f5f6f8; --card:#fff; --accent:#2346d8; --accent-ink:#fff; --live:#d92d3f; --ok:#17803d; --warn:#a15c00;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: var(--ink); line-height: 1.45; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); }
h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 0.35rem; }
h2 { font-size: 1.05rem; margin: 0 0 0.6rem; }
p { margin: 0 0 0.6rem; }
a { color: var(--accent); }
code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.8rem 1.5rem; background: var(--card); border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 0.5rem; color: var(--ink); font-weight: 700; text-decoration: none; }
.brand-dot { width: 0.65rem; height: 0.65rem; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px color-mix(in srgb, var(--live) 22%, transparent); }
.who { display: flex; align-items: center; gap: 0.75rem; font-size: 0.9rem; color: var(--muted); }
.who form { margin: 0; }
main { padding: 1.25rem 1.5rem 3rem; display: grid; gap: 1rem; max-width: 1000px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1.1rem 1.25rem; min-width: 0; }
.narrow { max-width: 380px; }
.muted { color: var(--muted); font-size: 0.92rem; }
.error { color: var(--live); font-weight: 600; }
.form { display: grid; gap: 0.75rem; }
label { display: grid; gap: 0.2rem; font-size: 0.86rem; font-weight: 600; color: var(--muted); }
input { width: 100%; font: inherit; font-size: 0.95rem; font-weight: 400; color: var(--ink); background: #fff; border: 1px solid #c6ced8; border-radius: 6px; padding: 0.45rem 0.6rem; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
button { font: inherit; font-weight: 600; cursor: pointer; color: var(--accent-ink); background: var(--accent); border: 0; border-radius: 6px; padding: 0.45rem 0.9rem; }
button.quiet { color: var(--ink); background: var(--paper); border: 1px solid var(--line); padding: 0.25rem 0.65rem; font-weight: 500; }
ul.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
ul.list li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.55rem 0; border-top: 1px solid var(--line); }
ul.list li:first-child { border-top: 0; }
.tag { background: var(--paper); border: 1px solid var(--line); border-radius: 99px; padding: 0.05rem 0.6rem; font-size: 0.82rem; color: var(--muted); }
.tag.active { color: var(--ok); }
.tag.provisioning { color: var(--warn); }
`;

export const Layout: FC<PropsWithChildren<{ title: string; user?: SessionUser; csrf?: string }>> = ({
  title,
  user,
  csrf,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} - sendwhatever admin</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header class="topbar">
        <a class="brand" href="/admin">
          <span class="brand-dot" />
          sendwhatever admin
        </a>
        {user && (
          <div class="who">
            <span>
              {user.email}
              {user.isSuperAdmin ? ' (super admin)' : ''}
            </span>
            {user.isSuperAdmin && <a href="/admin/manage/accounts">Manage</a>}
            <Form action="/admin/logout" csrf={csrf}>
              <button class="quiet" type="submit">
                Sign out
              </button>
            </Form>
          </div>
        )}
      </header>
      <main>{children}</main>
    </body>
  </html>
);

/**
 * The only way admin pages render a form. It always includes the hidden `_csrf` field. Pages with a
 * session pass the token. The login form has no session yet and relies on the Origin check.
 */
export const Form: FC<
  PropsWithChildren<{ action: string; csrf: string | undefined; class?: string }>
> = ({ action, csrf, class: className, children }) => (
  <form method="post" action={action} class={className}>
    <input type="hidden" name="_csrf" value={csrf ?? ''} />
    {children}
  </form>
);

export const LoginPage: FC<{ error?: string }> = ({ error }) => (
  <Layout title="Sign in">
    <section class="card narrow">
      <h1>Sign in</h1>
      {error && <p class="error">{error}</p>}
      <Form action="/admin/login" csrf={undefined} class="form">
        <label>
          Email
          <input type="email" name="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit">Sign in</button>
      </Form>
    </section>
  </Layout>
);

export interface AccountSummary {
  id: string;
  slug: string;
  status: string;
}

export const AccountsPage: FC<{
  user: SessionUser;
  csrf: string;
  accounts: AccountSummary[];
}> = ({ user, csrf, accounts }) => (
  <Layout title="Your accounts" user={user} csrf={csrf}>
    <section class="card">
      <h1>Your accounts</h1>
      {accounts.length === 0 ? (
        <p class="muted">
          {user.isSuperAdmin ? 'There are no accounts yet.' : 'You are not a member of any account.'}
        </p>
      ) : (
        <ul class="list">
          {accounts.map((account) => (
            <li>
              <a href={`/admin/accounts/${account.id}`}>{account.slug}</a>
              <span class={`tag ${account.status}`}>{account.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  </Layout>
);

export const AccountHomePage: FC<{
  user: SessionUser;
  csrf: string;
  account: AccountSummary;
  readOnly: boolean;
}> = ({ user, csrf, account, readOnly }) => (
  <Layout title={account.slug} user={user} csrf={csrf}>
    <section class="card">
      <h1>{account.slug}</h1>
      <p>
        <span class={`tag ${account.status}`}>{account.status}</span>
        {readOnly && <span class="tag">read-only (super admin)</span>}
      </p>
      <ul class="account-nav">
        <li>
          <a href={`/admin/accounts/${account.id}/connect`}>Connect</a>
        </li>
        <li>
          <a href={`/admin/accounts/${account.id}/credentials`}>Credentials</a>
        </li>
        <li>
          <a href={`/admin/accounts/${account.id}/schema`}>Schema</a>
        </li>
        <li>
          <a href={`/admin/accounts/${account.id}/traffic`}>Traffic</a>
        </li>
        <li>
          <a href={`/admin/accounts/${account.id}/pipeline`}>Pipeline</a>
        </li>
      </ul>
      <p>
        <a href="/admin">All accounts</a>
      </p>
    </section>
  </Layout>
);

export const ErrorPage: FC<{ status: number; message: string; user?: SessionUser }> = ({
  status,
  message,
  user,
}) => (
  <Layout title={String(status)} user={user}>
    <section class="card narrow">
      <h1>{message}</h1>
      <p>
        <a href="/admin">Back to the admin</a>
      </p>
    </section>
  </Layout>
);

import { tryGetContext } from 'hono/context-storage';
import type { FC, PropsWithChildren } from 'hono/jsx';
import type { AdminEnv } from './index.js';
import type { SessionUser } from './sessions.js';
import {
  accountNav,
  accountStatusVariant,
  activeNav,
  Callout,
  DataTable,
  EmptyState,
  Icon,
  LinkButton,
  LinkCard,
  LinkGrid,
  MANAGE_NAV,
  PageHeader,
  STYLESHEET_HREF,
  StatusPill,
  type NavItem,
  type NavKey,
} from './ui/index.js';

// Inline like the page's other handlers. Clipboard access needs HTTPS or localhost, so say so if it's missing.
const COPY_HANDLER = `var hint = this.querySelector('.copy-hint');
var show = function (text) { hint.textContent = text; setTimeout(function () { hint.textContent = 'Copy'; }, 1500); };
if (!navigator.clipboard) { show('Select to copy'); return; }
navigator.clipboard.writeText(this.querySelector('code').textContent).then(function () { show('Copied'); }, function () { show('Select to copy'); });`;

/**
 * A value that wraps inside its card and copies when clicked anywhere on it. Kept as one button so a
 * single click copies (e.g. a password in a list row). `CodeBlock` in ./ui is the same idea for
 * multi-line samples; pages move onto it as they're restyled.
 */
export const CopyBlock: FC<{ value: string; label: string }> = ({ value, label }) => (
  <button type="button" class="copy" aria-label={`Copy ${label}`} onclick={COPY_HANDLER}>
    <code>{value}</code>
    <span class="copy-hint">Copy</span>
  </button>
);

interface ShellAccount {
  id: string;
  slug: string;
  status: string;
  readOnly: boolean;
}

/**
 * What the shell needs from the request, read through `contextStorage()` so pages don't pass it.
 * Outside a request (e.g. a test rendering a view directly) there is no account or path.
 */
function shellContext(): { account?: ShellAccount; path: string } {
  const c = tryGetContext<AdminEnv>();
  if (!c) return { path: '' };
  return { account: c.get('account'), path: c.req.path };
}

const Brand: FC = () => (
  <a class="brand" href="/admin">
    <span class="brand-dot" aria-hidden="true" />
    sendwhatever
  </a>
);

const NavList: FC<{ title: string; items: NavItem[]; active?: NavKey }> = ({ title, items, active }) => (
  <nav class="nav" aria-label={title} data-nav={title.toLowerCase()}>
    <p class="nav-title">{title}</p>
    {items.map((item) => (
      <a
        class="nav-item"
        href={item.href}
        data-nav-key={item.key}
        aria-current={item.key === active ? 'page' : undefined}
      >
        <Icon name={item.icon} size={16} />
        {item.label}
      </a>
    ))}
  </nav>
);

const HOME_NAV: NavItem[] = [{ key: 'accounts', label: 'All accounts', icon: 'building', href: '/admin' }];

const Sidebar: FC<{ user: SessionUser; csrf?: string; account?: ShellAccount; path: string }> = ({
  user,
  csrf,
  account,
  path,
}) => {
  const active = activeNav(path);
  return (
    <aside class="sidebar">
      <Brand />
      {account && (
        <div class="side-account" data-account={account.id}>
          <span class="side-account-label">Account</span>
          <span class="side-account-slug">{account.slug}</span>
          <span class="side-account-meta">
            <StatusPill variant={accountStatusVariant(account.status)}>{account.status}</StatusPill>
            {account.readOnly && <span class="tag">read-only</span>}
          </span>
          <a class="side-account-switch" href="/admin">
            <Icon name="chevron-left" size={14} />
            All accounts
          </a>
        </div>
      )}
      <div class="side-navs">
        {account ? (
          <NavList title="Account" items={accountNav(account.id)} active={active} />
        ) : (
          <NavList title="Workspace" items={HOME_NAV} active={active} />
        )}
        {user.isSuperAdmin && <NavList title="Manage" items={MANAGE_NAV} active={active} />}
      </div>
      <div class="side-user">
        <span class="avatar" aria-hidden="true">
          {user.email.slice(0, 1)}
        </span>
        <span class="side-user-text">
          <span class="side-user-email" title={user.email}>
            {user.email}
          </span>
          <span class="side-user-role">{user.isSuperAdmin ? 'Super admin' : 'Member'}</span>
        </span>
        <Form action="/admin/logout" csrf={csrf}>
          <button class="btn btn-ghost" type="submit" aria-label="Sign out" title="Sign out">
            <Icon name="log-out" size={16} />
          </button>
        </Form>
      </div>
    </aside>
  );
};

/**
 * Every admin page renders inside this. With a user it draws the app shell (sidebar plus content
 * column). Without one (login, logged-out errors) it centers the content with no sidebar.
 */
export const Layout: FC<PropsWithChildren<{ title: string; user?: SessionUser; csrf?: string }>> = ({
  title,
  user,
  csrf,
  children,
}) => {
  const { account, path } = shellContext();
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} - sendwhatever admin</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
      </head>
      {user ? (
        <body>
          <div class="shell">
            <Sidebar user={user} csrf={csrf} account={account} path={path} />
            <div class="main">
              <main class="content">{children}</main>
            </div>
          </div>
        </body>
      ) : (
        <body>
          <div class="centered">
            <div class="auth-brand">
              <Brand />
            </div>
            <main>{children}</main>
          </div>
        </body>
      )}
    </html>
  );
};

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
    <section class="card auth-card">
      <h1>Sign in</h1>
      <p class="muted">Welcome back. Sign in to the admin console.</p>
      <Form action="/admin/login" csrf={undefined} class="form">
        {error && <Callout variant="danger">{error}</Callout>}
        <label>
          Email
          <input type="email" name="email" autocomplete="username" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button class="btn-block" type="submit">
          Sign in
        </button>
      </Form>
    </section>
    <p class="auth-foot">sendwhatever admin</p>
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
    <PageHeader
      title="Your accounts"
      description={
        user.isSuperAdmin
          ? 'Every account on the platform. Open one to see its data.'
          : 'Accounts you are a member of.'
      }
      actions={
        user.isSuperAdmin && (
          <LinkButton href="/admin/manage/accounts" icon="settings">
            Manage accounts
          </LinkButton>
        )
      }
    />
    <section class="card section">
      <div class="section-body flush">
        <DataTable
          rows={accounts}
          caption="Accounts"
          empty={
            <EmptyState
              icon="building"
              title={
                user.isSuperAdmin ? 'There are no accounts yet.' : 'You are not a member of any account.'
              }
              description={
                user.isSuperAdmin
                  ? 'Create the first account to start sending data.'
                  : 'Ask a super admin to add you to an account.'
              }
              action={
                user.isSuperAdmin && (
                  <LinkButton href="/admin/manage/accounts" variant="primary" icon="plus">
                    Create an account
                  </LinkButton>
                )
              }
            />
          }
          columns={[
            {
              header: 'Account',
              cell: (account) => <a href={`/admin/accounts/${account.id}`}>{account.slug}</a>,
            },
            {
              header: 'Status',
              width: '160px',
              cell: (account) => (
                <StatusPill variant={accountStatusVariant(account.status)}>{account.status}</StatusPill>
              ),
            },
            {
              header: <span class="visually-hidden">Open</span>,
              width: '56px',
              align: 'right',
              cell: (account) => (
                <a
                  href={`/admin/accounts/${account.id}`}
                  aria-label={`Open ${account.slug}`}
                  class="btn btn-ghost btn-sm"
                >
                  <Icon name="chevron-right" size={14} />
                </a>
              ),
            },
          ]}
        />
      </div>
    </section>
  </Layout>
);

const OVERVIEW_DESCRIPTIONS: Partial<Record<NavKey, string>> = {
  connect: 'Send data with curl or webhooks, and connect to your database.',
  credentials: 'Create and revoke API keys, and get your database login.',
  schema: 'Tables and columns created from the data you send.',
  traffic: 'Requests per minute over the last hour, by source.',
  pipeline: 'Jobs waiting for the worker, and retries.',
};

export const AccountHomePage: FC<{
  user: SessionUser;
  csrf: string;
  account: AccountSummary;
  readOnly: boolean;
}> = ({ user, csrf, account, readOnly }) => (
  <Layout title={account.slug} user={user} csrf={csrf}>
    <PageHeader
      breadcrumbs={[{ label: 'Accounts', href: '/admin' }, { label: account.slug }]}
      title={
        <>
          {account.slug}
          <StatusPill variant={accountStatusVariant(account.status)}>{account.status}</StatusPill>
          {readOnly && <span class="tag">read-only (super admin)</span>}
        </>
      }
      description="Overview. Pick a section to get started."
    />
    <LinkGrid>
      {accountNav(account.id)
        .filter((item) => item.key !== 'overview')
        .map((item) => (
          <LinkCard
            href={item.href}
            icon={item.icon}
            title={item.label}
            description={OVERVIEW_DESCRIPTIONS[item.key] ?? ''}
          />
        ))}
    </LinkGrid>
  </Layout>
);

export const ErrorPage: FC<{ status: number; message: string; user?: SessionUser }> = ({
  status,
  message,
  user,
}) => (
  <Layout title={String(status)} user={user}>
    <section class="card">
      <EmptyState
        icon={status >= 500 ? 'alert-triangle' : 'search'}
        title={message}
        description={`Error ${status}`}
        action={
          <LinkButton href="/admin" icon="chevron-left">
            Back to the admin
          </LinkButton>
        }
      />
    </section>
  </Layout>
);

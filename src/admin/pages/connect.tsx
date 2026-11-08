import type { Handler } from 'hono';
import { ingestEndpoint } from '../public-addresses.js';
import { Layout } from '../views.js';
import { CodeBlock, EmptyState, LinkButton, PageHeader, Section } from '../ui/index.js';
import type { AdminEnv } from '../index.js';
import { connectionString, loadReadLogin } from './credentials.js';

export const connectPage: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const login = await loadReadLogin(c);
  const endpoint = ingestEndpoint(c.get('deps').config);
  const curl = [
    `curl -X POST ${endpoint} \\`,
    `  -H 'X-Account-Slug: ${account.slug}' \\`,
    `  -H "Authorization: Bearer $API_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"hello": "world"}'`,
  ].join('\n');
  const credentialsUrl = `/admin/accounts/${account.id}/credentials`;
  const webhook = `${endpoint}/<source>?key=<API_KEY>`;

  return c.html(
    <Layout title="Connect" user={c.get('user')} csrf={c.get('csrf')}>
      <PageHeader
        breadcrumbs={[
          { label: 'Accounts', href: '/admin' },
          { label: account.slug, href: `/admin/accounts/${account.id}` },
          { label: 'Connect' },
        ]}
        title="Connect"
        description="Send data with curl or webhooks, and read it back with any Postgres client."
        actions={
          <LinkButton href={credentialsUrl} icon="key">
            Credentials
          </LinkButton>
        }
      />
      <Section
        title="Send data"
        description={
          <>
            POST any JSON to <code>{endpoint}</code> with the header <code>X-Account-Slug: {account.slug}</code> and
            an API key.
          </>
        }
      >
        <CodeBlock value={curl} label="curl example" caption="curl" />
        <p class="muted">
          Replace <code>$API_KEY</code> with a key from <a href={credentialsUrl}>Credentials</a>.
        </p>
      </Section>
      <Section
        title="Webhooks"
        description="For providers that call a URL. The first segment after /ingest/ is the source."
      >
        <CodeBlock value={webhook} label="webhook URL" caption="Webhook URL" />
        <p class="muted">
          Use <code>?key=</code> for providers that cannot set an <code>Authorization</code> header.
        </p>
      </Section>
      <Section title="Read your data" description="Connect any Postgres client with a read-only login.">
        {login ? (
          <>
            <CodeBlock value={connectionString(login, false)} label="connection string" caption="Connection string" />
            <p class="muted">
              The password is not shown here. <a href={credentialsUrl}>Reveal it on Credentials</a>.
            </p>
          </>
        ) : (
          <EmptyState icon="table" title="No active store yet" description="This account has no active store yet." />
        )}
        <p class="muted">
          Or read rows over HTTP with a read-only API key. Each table on the{' '}
          <a href={`/admin/accounts/${account.id}/schema`}>Schema</a> page links to its API docs.
        </p>
      </Section>
    </Layout>,
  );
};

import type { Handler } from 'hono';
import { ingestEndpoint } from '../public-addresses.js';
import { CopyBlock, Layout } from '../views.js';
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

  return c.html(
    <Layout title="Connect" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Connect: {account.slug}</h1>
        <p class="muted">
          <a href={`/admin/accounts/${account.id}`}>Back to {account.slug}</a> ·{' '}
          <a href={credentialsUrl}>Credentials</a>
        </p>
      </section>
      <section class="card">
        <h2>Send data</h2>
        <p>
          POST any JSON to <code>{endpoint}</code>. Every request needs the header{' '}
          <code>X-Account-Slug: {account.slug}</code> and an API key.
        </p>
        <CopyBlock value={curl} label="curl example" />
        <p class="muted">
          Replace <code>$API_KEY</code> with a key from <a href={credentialsUrl}>Credentials</a>.
        </p>
      </section>
      <section class="card">
        <h2>Webhooks</h2>
        <p>
          <code>{`https://${account.slug}.<your-api-domain>/ingest/<source>?key=<API_KEY>`}</code>
        </p>
        <p class="muted">
          The first segment after <code>/ingest/</code> is the source. Use <code>?key=</code> for
          providers that cannot set an <code>Authorization</code> header.
        </p>
      </section>
      <section class="card">
        <h2>Read your data</h2>
        {login ? (
          <>
            <CopyBlock value={connectionString(login, false)} label="connection string" />
            <p class="muted">
              The password is not shown here. <a href={credentialsUrl}>Reveal it on Credentials</a>.
            </p>
          </>
        ) : (
          <p class="muted">This account has no active store yet.</p>
        )}
      </section>
    </Layout>,
  );
};

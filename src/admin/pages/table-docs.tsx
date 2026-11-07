import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Context, Handler } from 'hono';
import { html } from 'hono/html';
import { HttpError } from '../../http/deps.js';
import { buildTableSpec } from '../../tables/openapi.js';
import type { AdminEnv } from '../index.js';
import { getActiveStore, getSchemaTables, type SchemaTable } from '../stats.js';

export const SWAGGER_ASSET_PATH = '/admin/assets/swagger';

// Served from this origin, so no third-party script runs on a logged-in page. Swagger UI sets inline
// styles and uses data: images, and the spec names no other origin to connect to.
const DOCS_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// A file rather than an inline script, so the CSP needs no 'unsafe-inline' for scripts. No validator
// or query config, so the page never calls out or loads a spec named in its URL.
const INIT_SCRIPT = `window.addEventListener('load', function () {
  var node = document.getElementById('swagger-ui');
  SwaggerUIBundle({
    url: node.dataset.specUrl,
    domNode: node,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    validatorUrl: null,
    queryConfigEnabled: false,
    showExtensions: true,
  });
});`;

const swaggerDir = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));

const ASSET_TYPES: Record<string, string> = {
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
  'swagger-ui.css': 'text/css; charset=utf-8',
  'init.js': 'text/javascript; charset=utf-8',
};
const assets = new Map<string, string>();

function assetBody(name: string): string {
  if (name === 'init.js') return INIT_SCRIPT;
  let body = assets.get(name);
  if (body === undefined) {
    body = readFileSync(join(swaggerDir, name), 'utf8');
    assets.set(name, body);
  }
  return body;
}

export const swaggerAsset: Handler<AdminEnv> = (c) => {
  const name = c.req.param('file')!;
  if (!Object.hasOwn(ASSET_TYPES, name)) throw new HttpError(404, 'Page not found');
  return c.body(assetBody(name), 200, {
    'content-type': ASSET_TYPES[name]!,
    'x-content-type-options': 'nosniff',
  });
};

async function loadTable(c: Context<AdminEnv>): Promise<SchemaTable> {
  const { appDb } = c.get('deps');
  const store = await getActiveStore(appDb, c.get('account')!.id);
  const tables = store ? await getSchemaTables(appDb, store.id) : [];
  const table = tables.find(({ name }) => name === c.req.param('table'));
  if (!table) throw new HttpError(404, 'Page not found');
  return table;
}

export const tableSpecRoute: Handler<AdminEnv> = async (c) =>
  c.json(buildTableSpec(await loadTable(c), c.get('account')!.slug));

export const tableDocsRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const table = await loadTable(c);
  const base = `/admin/accounts/${account.id}`;
  const specUrl = `${base}/schema/${encodeURIComponent(table.name)}/openapi.json`;
  c.header('content-security-policy', DOCS_CSP);
  return c.html(
    html`<!doctype html>${(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{table.name} API - sendwhatever admin</title>
          <link rel="stylesheet" href={`${SWAGGER_ASSET_PATH}/swagger-ui.css`} />
        </head>
        <body>
          <p>
            <a href={`${base}/schema`}>Back to schema</a> ·{' '}
            <a href={`${base}/credentials`}>Get a read-only API key</a>
          </p>
          <div id="swagger-ui" data-spec-url={specUrl} />
          <script src={`${SWAGGER_ASSET_PATH}/swagger-ui-bundle.js`} />
          <script src={`${SWAGGER_ASSET_PATH}/init.js`} />
        </body>
      </html>
    )}`,
  );
};

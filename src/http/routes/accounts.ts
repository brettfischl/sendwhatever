import { Hono } from 'hono';
import { AccountError, createAccount, type AccountErrorCode } from '../../accounts/create.js';
import { internalOnly } from '../auth.js';
import { HttpError, type AppEnv } from '../deps.js';

const STATUS: Record<AccountErrorCode, 400 | 409 | 500 | 503> = {
  invalid_slug: 400,
  invalid_storage: 400,
  exists: 409,
  provision_unavailable: 503,
  provision_failed: 500,
};

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.use('*', internalOnly);

accountRoutes.post('/', async (c) => {
  const body = await readJson(c.req.raw);
  try {
    const created = await createAccount(c.get('deps'), { slug: body.slug, storage: body.storage });
    return c.json(
      {
        account_id: created.accountId,
        slug: created.slug,
        api_key: created.apiKey,
        database: created.database,
      },
      201,
    );
  } catch (error) {
    if (error instanceof AccountError) throw new HttpError(STATUS[error.code], error.message);
    throw error;
  }
});

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

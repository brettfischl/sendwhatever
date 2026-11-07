import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function otherDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describe('local Postgres', () => {
  it('runs Postgres 16 or later, with sw_app on its own database and role', async () => {
    const row = await withClient(config.appDatabaseUrl, async (client) => {
      const result = await client.query(
        `SELECT current_database() AS db, current_user AS role,
                current_setting('server_version_num')::int AS version`,
      );
      return result.rows[0];
    });
    expect(row.db).toBe('sw_app');
    expect(row.role).toBe('sw_app');
    expect(row.version).toBeGreaterThanOrEqual(160000);
  });

  it('has the baseline migration applied', async () => {
    const names = await withClient(config.appDatabaseUrl, async (client) => {
      const result = await client.query('SELECT name FROM schema_migrations');
      return result.rows.map((row) => row.name);
    });
    expect(names).toContain('0001_baseline');
  });

  it('connects the sw_data role to sw_data', async () => {
    const db = await withClient(config.dataDatabaseUrl, async (client) => {
      const result = await client.query('SELECT current_database() AS db');
      return result.rows[0].db;
    });
    expect(db).toBe('sw_data');
  });

  it('denies the sw_data role any connection to sw_app', async () => {
    await expect(
      withClient(otherDatabase(config.dataDatabaseUrl, 'sw_app'), async () => undefined),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('stops the sw_data role granting itself the sw_app role', async () => {
    await withClient(config.dataDatabaseUrl, async (client) => {
      await expect(client.query('GRANT sw_app TO sw_data')).rejects.toMatchObject({
        code: '42501',
      });
    });
  });

  it('denies the sw_app role any connection to sw_data', async () => {
    await expect(
      withClient(otherDatabase(config.appDatabaseUrl, 'sw_data'), async () => undefined),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

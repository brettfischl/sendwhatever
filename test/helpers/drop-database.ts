import pg from 'pg';

const ATTEMPTS = 10;
const RETRY_MS = 500;

/**
 * Drops a test's store database. `WITH (FORCE)` ends other sessions in it, and fails with `permission
 * denied to terminate process` if one belongs to a superuser, as an autovacuum worker on a new database
 * does. That worker soon moves on, so this tries again rather than failing the run in its teardown.
 */
export async function dropDatabase(admin: Pick<pg.ClientBase, 'query'>, name: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '42501' || attempt >= ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}

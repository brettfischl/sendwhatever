import pg from 'pg';
import { readOnlyRoleName } from '../../src/storage/postgres/sql.js';
import { dropDatabase } from './drop-database.js';

interface ForeignKey {
  child: string;
  parent: string;
  childColumns: string[];
  parentColumns: string[];
}

/** Every foreign key in `public`, read from the catalog so a new table is covered without editing a list. */
async function foreignKeys(appDb: Pick<pg.Pool, 'query'>): Promise<ForeignKey[]> {
  const columns = (relation: string, keys: string) => `
    (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(c.${keys}) WITH ORDINALITY k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.${relation} AND a.attnum = k.attnum)`;
  const { rows } = await appDb.query<{
    child: string;
    parent: string;
    child_columns: string[];
    parent_columns: string[];
  }>(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
            ${columns('conrelid', 'conkey')} AS child_columns,
            ${columns('confrelid', 'confkey')} AS parent_columns
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  return rows.map((row) => ({
    child: row.child,
    parent: row.parent,
    childColumns: row.child_columns,
    parentColumns: row.parent_columns,
  }));
}

/**
 * The statements that delete an account's rows from every table that references `accounts`, directly or
 * through other tables (`data_columns` reaches an account only through `account_stores`), children before
 * parents, ending with `accounts` itself. Built from the foreign keys, so it can't miss a table the schema
 * links in. Each statement takes the account id as `$1`.
 */
export function deletionPlan(keys: ForeignKey[]): { table: string; sql: string }[] {
  // Tables that reach `accounts`, each with the key it is filtered through: one straight to `accounts`
  // when there is one, else the first key to a table already reached.
  const via = new Map<string, ForeignKey>();
  const reached = ['accounts'];
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of keys) {
      if (key.child === key.parent || key.child === 'accounts' || !reached.includes(key.parent)) continue;
      const known = via.get(key.child);
      if (!known || (key.parent === 'accounts' && known.parent !== 'accounts')) {
        via.set(key.child, key);
        if (!reached.includes(key.child)) reached.push(key.child);
        grew = true;
      }
    }
  }

  // Parents get a lower depth than their children, so deleting deepest first removes children first.
  const depth = new Map<string, number>([['accounts', 0]]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of keys) {
      if (key.child === key.parent || !reached.includes(key.child) || !depth.has(key.parent)) continue;
      const next = depth.get(key.parent)! + 1;
      if ((depth.get(key.child) ?? 0) < next) {
        depth.set(key.child, next);
        changed = true;
      }
    }
  }

  const filters = new Map<string, string>([['accounts', 'id = $1']]);
  const filterOf = (table: string): string => {
    const known = filters.get(table);
    if (known) return known;
    const key = via.get(table)!;
    const own = key.childColumns.map((column) => pg.escapeIdentifier(column)).join(', ');
    const theirs = key.parentColumns.map((column) => pg.escapeIdentifier(column)).join(', ');
    const filter = `(${own}) IN (SELECT ${theirs} FROM ${key.parent} WHERE ${filterOf(key.parent)})`;
    filters.set(table, filter);
    return filter;
  };

  return [...reached]
    .sort((x, y) => depth.get(y)! - depth.get(x)!)
    .map((table) => ({ table, sql: `DELETE FROM ${table} WHERE ${filterOf(table)}` }));
}

/**
 * Removes a test account completely: its rows in every table that references it, the account itself, and
 * the store databases and read-only logins it owned. `admin` is a connection that can drop databases and
 * roles (the `sw_data` login). Safe to call after other code wrote rows for the account.
 */
export async function removeAccount(
  appDb: pg.Pool,
  admin: Pick<pg.ClientBase, 'query'>,
  accountId: string,
): Promise<void> {
  // Read before the rows go: every generation of the account's store, not just the first.
  const { rows } = await appDb.query<{ namespace: string }>(
    'SELECT namespace FROM account_stores WHERE account_id = $1',
    [accountId],
  );
  const plan = deletionPlan(await foreignKeys(appDb));

  const client = await appDb.connect();
  try {
    await client.query('BEGIN');
    for (const { sql } of plan) await client.query(sql, [accountId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  for (const { namespace } of rows) {
    await dropDatabase(admin, namespace);
    await admin.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(readOnlyRoleName(namespace))}`);
  }
}

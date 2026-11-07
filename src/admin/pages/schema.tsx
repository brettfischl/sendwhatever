import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { getActiveStore, getRowCounts, getSchemaTables, type SchemaTable } from '../stats.js';
import { Layout } from '../views.js';

// Page-local styles: the shared stylesheet in views.tsx is left alone.
const CSS = `
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); }
table.grid th { color: var(--muted); font-weight: 600; }
`;

const TableLinks: FC<{ label: string; names: string[] }> = ({ label, names }) =>
  names.length === 0 ? null : (
    <p class="muted">
      {label}: {names.join(', ')}
    </p>
  );

export const SchemaRegion: FC<{
  accountId: string;
  store: boolean;
  tables: SchemaTable[];
  counts: Map<string, number | null>;
}> = ({ accountId, store, tables, counts }) => {
  if (!store) return <p class="muted">This account has no active store yet.</p>;
  if (tables.length === 0) return <p class="muted">No tables yet. They appear as data arrives.</p>;
  const unavailable = [...counts.values()].every((n) => n === null);
  return (
    <>
      {unavailable && <p class="muted">Row counts are unavailable right now.</p>}
      {tables.map((table) => (
        <section class="card" data-table={table.name}>
          <h2>
            <code>{table.name}</code> <span class="tag">{counts.get(table.name) ?? '—'} rows</span>
          </h2>
          <p>
            <a href={`/admin/accounts/${accountId}/schema/${encodeURIComponent(table.name)}/docs`}>
              API docs
            </a>
          </p>
          <TableLinks label="Child of" names={table.parents} />
          <TableLinks label="Parent of" names={table.children} />
          <table class="grid">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {table.columns.map((column) => (
                <tr>
                  <td>
                    <code>{column.name}</code>
                  </td>
                  <td>{column.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
};

export const schemaRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const { appDb, config } = c.get('deps');
  const store = await getActiveStore(appDb, account.id);
  const tables = store ? await getSchemaTables(appDb, store.id) : [];
  const counts = store
    ? await getRowCounts(
        store,
        config.encryptionKey,
        tables.map((t) => t.name),
      )
    : new Map<string, number | null>();
  const region = (
    <SchemaRegion accountId={account.id} store={!!store} tables={tables} counts={counts} />
  );
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Schema" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Schema: {account.slug}</h1>
        <p class="muted">Tables created from your data. This page refreshes itself.</p>
      </section>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <LiveRegion>{region}</LiveRegion>
    </Layout>,
  );
};

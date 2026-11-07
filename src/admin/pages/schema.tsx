import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { getActiveStore, getRowCounts, getSchemaTables, type SchemaTable } from '../stats.js';
import { Layout } from '../views.js';
import { getPipelineSummary } from '../../pipeline/status.js';

// Page-local styles: the shared stylesheet in ui/styles.ts is left alone.
const CSS = `
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); }
table.grid th { color: var(--muted); font-weight: 600; }
.waiting-notice { margin: 0 0 1rem; }
`;

/** Events quarantined as a new shape, which become tables once an adapter is generated (§12.1). */
export interface Waiting {
  events: number;
  shapes: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
  waiting: Waiting;
}> = ({ accountId, store, tables, counts, waiting }) => {
  if (!store) return <p class="muted">This account has no active store yet.</p>;
  const pipeline = `/admin/accounts/${accountId}/pipeline`;
  if (tables.length === 0) {
    if (waiting.events === 0) return <p class="muted">No tables yet. They appear as data arrives.</p>;
    return (
      <p data-waiting>
        No tables yet. <strong>{plural(waiting.events, 'event', 'events')}</strong>{' '}
        {waiting.events === 1 ? 'is' : 'are'} waiting for an adapter to be generated (
        <strong>{plural(waiting.shapes, 'new shape', 'new shapes')}</strong>). <a href={pipeline}>See Pipeline</a>.
      </p>
    );
  }
  const unavailable = [...counts.values()].every((n) => n === null);
  return (
    <>
      {waiting.events > 0 && (
        <p class="waiting-notice" data-waiting>
          {plural(waiting.events, 'event', 'events')} ({plural(waiting.shapes, 'new shape', 'new shapes')}){' '}
          {waiting.events === 1 ? 'is' : 'are'} waiting for an adapter. <a href={pipeline}>See Pipeline</a>.
        </p>
      )}
      {unavailable && <p class="muted">Row counts are unavailable right now.</p>}
      {tables.map((table) => (
        <section class="card" data-table={table.name}>
          <h2>
            <code>{table.name}</code> <span class="tag">{counts.get(table.name) ?? '—'} rows</span>
          </h2>
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
  const summary = store ? await getPipelineSummary(appDb, account.id) : undefined;
  const waiting = { events: summary?.waitingEvents ?? 0, shapes: summary?.waitingShapeCount ?? 0 };
  const region = (
    <SchemaRegion accountId={account.id} store={!!store} tables={tables} counts={counts} waiting={waiting} />
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

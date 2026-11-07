import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { getPipeline, type Pipeline } from '../stats.js';
import { Layout } from '../views.js';

// Page-local styles: the shared stylesheet in ui/styles.ts is left alone.
const CSS = `
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); }
table.grid th { color: var(--muted); font-weight: 600; }
table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const PipelineRegion: FC<{ pipeline: Pipeline }> = ({ pipeline }) => (
  <>
    <section class="card">
      <h2>Queue depth</h2>
      <p>
        <strong data-depth>{pipeline.depth}</strong> jobs queued. Oldest job:{' '}
        <strong data-oldest>
          {pipeline.oldestAgeSeconds === null ? '—' : formatAge(pipeline.oldestAgeSeconds)}
        </strong>
      </p>
      {pipeline.depthByKind.length > 0 && (
        <table class="grid">
          <thead>
            <tr>
              <th>Kind</th>
              <th class="num">Jobs</th>
            </tr>
          </thead>
          <tbody>
            {pipeline.depthByKind.map((row) => (
              <tr>
                <td>{row.kind}</td>
                <td class="num">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
    <section class="card">
      <h2>Retries</h2>
      {pipeline.retries.length === 0 ? (
        <p class="muted">No jobs have been retried.</p>
      ) : (
        <table class="grid">
          <thead>
            <tr>
              <th>Job</th>
              <th>Kind</th>
              <th class="num">Attempts</th>
              <th class="num">Age</th>
            </tr>
          </thead>
          <tbody>
            {pipeline.retries.map((job) => (
              <tr>
                <td>
                  <code>{job.id.slice(0, 8)}</code>
                </td>
                <td>{job.kind}</td>
                <td class="num">{job.attempts}</td>
                <td class="num">{formatAge(job.ageSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  </>
);

export const pipelineRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const region = <PipelineRegion pipeline={await getPipeline(c.get('deps').appDb, account.id)} />;
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Pipeline" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Pipeline: {account.slug}</h1>
        <p class="muted">Jobs waiting for the worker. This page refreshes itself.</p>
      </section>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <LiveRegion>{region}</LiveRegion>
    </Layout>,
  );
};

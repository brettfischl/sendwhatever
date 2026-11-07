import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { TRAFFIC_WINDOW_MINUTES, getTraffic, type Traffic } from '../stats.js';
import { Layout } from '../views.js';

// Page-local styles: the shared stylesheet in views.tsx is left alone.
const CSS = `
table.grid { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
table.grid th, table.grid td { text-align: left; padding: 0.3rem 0.5rem; border-top: 1px solid var(--line); }
table.grid th { color: var(--muted); font-weight: 600; }
table.grid td.num, table.grid th.num { text-align: right; font-variant-numeric: tabular-nums; }
`;

const displaySource = (source: string) => (source === '' ? '(no path)' : source);

const W = 720;
const H = 160;
const BAR = W / TRAFFIC_WINDOW_MINUTES;

/** One bar per minute, oldest on the left, deletes stacked on writes. No JS, no library. */
const Chart: FC<{ traffic: Traffic }> = ({ traffic }) => {
  const minutes = Array.from({ length: TRAFFIC_WINDOW_MINUTES }, () => ({ write: 0, delete: 0 }));
  for (const r of traffic.rows) {
    const bucket = minutes[r.minutesAgo];
    if (bucket && (r.op === 'write' || r.op === 'delete')) bucket[r.op] += r.count;
  }
  const max = Math.max(1, ...minutes.map((m) => m.write + m.delete));
  const scale = (H - 4) / max;
  return (
    <svg
      style="width:100%;height:auto;display:block"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Requests per minute, last 60 minutes"
    >
      <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#dfe4ea" />
      {minutes.map((m, i) => {
        // Index 0 is the current minute, which sits on the right.
        const x = (TRAFFIC_WINDOW_MINUTES - 1 - i) * BAR;
        const hw = m.write * scale;
        const hd = m.delete * scale;
        return (
          <g>
            <title>{`${i} min ago: ${m.write} writes, ${m.delete} deletes`}</title>
            {m.write > 0 && (
              <rect x={x + 1} y={H - hw} width={BAR - 2} height={hw} fill="#2346d8" data-op="write" />
            )}
            {m.delete > 0 && (
              <rect
                x={x + 1}
                y={H - hw - hd}
                width={BAR - 2}
                height={hd}
                fill="#d92d3f"
                data-op="delete"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
};

export const TrafficRegion: FC<{ traffic: Traffic }> = ({ traffic }) => {
  const pairs = new Map<string, number>();
  for (const r of traffic.rows) {
    const key = JSON.stringify([r.source, r.op]);
    pairs.set(key, (pairs.get(key) ?? 0) + r.count);
  }
  return (
    <>
      <section class="card">
        <h2>
          Requests per minute <span class="tag">{traffic.total} in the last hour</span>
        </h2>
        <Chart traffic={traffic} />
        <p class="muted">
          Oldest minute on the left. <span style="color:#2346d8">Writes</span> and{' '}
          <span style="color:#d92d3f">deletes</span>.
        </p>
      </section>
      <section class="card">
        <h2>By source and operation</h2>
        {traffic.total === 0 ? (
          <p class="muted">No requests in the last hour.</p>
        ) : (
          <table class="grid">
            <thead>
              <tr>
                <th>Source</th>
                <th>Operation</th>
                <th class="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {[...pairs].map(([key, count]) => {
                const [source, op] = JSON.parse(key) as [string, string];
                return (
                  <tr>
                    <td>{displaySource(source)}</td>
                    <td>{op}</td>
                    <td class="num">{count}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {traffic.bySource.map((row) => (
                <tr>
                  <th>{displaySource(row.source)}</th>
                  <th>all operations</th>
                  <th class="num">{row.count}</th>
                </tr>
              ))}
              {traffic.byOp.map((row) => (
                <tr>
                  <th>all sources</th>
                  <th>{row.op}</th>
                  <th class="num">{row.count}</th>
                </tr>
              ))}
            </tfoot>
          </table>
        )}
      </section>
    </>
  );
};

export const trafficRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const region = <TrafficRegion traffic={await getTraffic(c.get('deps').appDb, account.id)} />;
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Traffic" user={c.get('user')} csrf={c.get('csrf')}>
      <section class="card">
        <h1>Traffic: {account.slug}</h1>
        <p class="muted">Requests received in the last 60 minutes. This page refreshes itself.</p>
      </section>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <LiveRegion>{region}</LiveRegion>
    </Layout>,
  );
};

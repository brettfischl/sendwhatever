import type { Handler } from 'hono';
import type { FC } from 'hono/jsx';
import type { AdminEnv } from '../index.js';
import { LiveRegion, isFragmentRequest } from '../live.js';
import { TRAFFIC_WINDOW_MINUTES, getTraffic, type Traffic } from '../stats.js';
import { DataTable, EmptyState, PageHeader, Section, StatGrid, StatTile } from '../ui/index.js';
import { Layout } from '../views.js';

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
      <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} style="stroke:var(--border)" />
      {minutes.map((m, i) => {
        // Index 0 is the current minute, which sits on the right.
        const x = (TRAFFIC_WINDOW_MINUTES - 1 - i) * BAR;
        const hw = m.write * scale;
        const hd = m.delete * scale;
        return (
          <g>
            <title>{`${i} min ago: ${m.write} writes, ${m.delete} deletes`}</title>
            {m.write > 0 && (
              <rect x={x + 1} y={H - hw} width={BAR - 2} height={hw} style="fill:var(--accent)" data-op="write" />
            )}
            {m.delete > 0 && (
              <rect
                x={x + 1}
                y={H - hw - hd}
                width={BAR - 2}
                height={hd}
                style="fill:var(--danger)"
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
  const byPair = [...pairs].map(([key, count]) => {
    const [source, op] = JSON.parse(key) as [string, string];
    return { source, op, count };
  });
  const opCount = (op: string) => traffic.byOp.find((row) => row.op === op)?.count ?? 0;
  const empty = <EmptyState icon="activity" title="No requests in the last hour." />;
  return (
    <>
      <StatGrid>
        <StatTile label="Requests" value={traffic.total} hint="in the last hour" />
        <StatTile label="Writes" value={opCount('write')} hint="in the last hour" />
        <StatTile label="Deletes" value={opCount('delete')} hint="in the last hour" />
      </StatGrid>
      <Section
        title="Requests per minute"
        description={
          <>
            Oldest minute on the left. <span style="color:var(--accent)">Writes</span> and{' '}
            <span style="color:var(--danger)">deletes</span>.
          </>
        }
      >
        <Chart traffic={traffic} />
      </Section>
      <Section title="By source and operation" flush>
        <DataTable
          rows={byPair}
          caption="Requests by source and operation"
          empty={empty}
          columns={[
            { header: 'Source', cell: (r) => displaySource(r.source) },
            { header: 'Operation', cell: (r) => r.op },
            { header: 'Requests', align: 'right', cell: (r) => r.count },
          ]}
        />
      </Section>
      {traffic.bySource.length > 0 && (
        <Section title="Totals by source" flush>
          <DataTable
            rows={traffic.bySource}
            caption="Requests by source"
            columns={[
              { header: 'Source', cell: (r) => displaySource(r.source) },
              { header: 'Requests', align: 'right', cell: (r) => r.count },
            ]}
          />
        </Section>
      )}
    </>
  );
};

export const trafficRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const region = <TrafficRegion traffic={await getTraffic(c.get('deps').appDb, account.id)} />;
  if (isFragmentRequest(c)) return c.html(region);
  return c.html(
    <Layout title="Traffic" user={c.get('user')} csrf={c.get('csrf')}>
      <PageHeader
        breadcrumbs={[
          { label: 'Accounts', href: '/admin' },
          { label: account.slug, href: `/admin/accounts/${account.id}` },
          { label: 'Traffic' },
        ]}
        title="Traffic"
        description="Requests received in the last 60 minutes. This page refreshes itself."
      />
      <LiveRegion>{region}</LiveRegion>
    </Layout>,
  );
};

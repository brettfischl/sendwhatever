import type { Handler } from 'hono';
import { HttpError } from '../../http/deps.js';
import { isUuid } from '../../pipeline/status.js';
import {
  getAdapterDetail,
  listShapes,
  ATTEMPT_LIMIT,
  type ShapeStatus,
  type VersionStatus,
} from '../adapters-queries.js';
import type { AdminEnv } from '../index.js';
import { CodeBlock, DataTable, EmptyState, PageHeader, Section, StatusPill, type StatusVariant } from '../ui/index.js';
import { Layout } from '../views.js';

// Makes the first cell's link cover the whole row. The shared DataTable can't make a row clickable.
const CSS = `
.data-table tbody tr:has(.row-link) { position: relative; }
.data-table .row-link::after { content: ''; position: absolute; inset: 0; }
.data-table tbody tr:has(.row-link):hover { cursor: pointer; }
.adapter-details { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0; }
.adapter-details dt { color: var(--muted); }
.adapter-details dd { margin: 0; overflow-wrap: anywhere; }
`;

const SHAPE_STATUS: Record<ShapeStatus, { variant: StatusVariant; label: string }> = {
  active: { variant: 'success', label: 'Active' },
  awaiting_approval: { variant: 'warning', label: 'Awaiting approval' },
  failing: { variant: 'danger', label: 'Failing' },
  generating: { variant: 'progress', label: 'Generating' },
  draft: { variant: 'neutral', label: 'Draft' },
};

const VERSION_STATUS: Record<VersionStatus, { variant: StatusVariant; label: string }> = {
  active: SHAPE_STATUS.active,
  awaiting_approval: SHAPE_STATUS.awaiting_approval,
  superseded: { variant: 'neutral', label: 'Superseded' },
  draft: SHAPE_STATUS.draft,
};

const ATTEMPT_STATUS: Record<string, { variant: StatusVariant; label: string }> = {
  running: { variant: 'progress', label: 'Running' },
  succeeded: { variant: 'success', label: 'Succeeded' },
  failed: { variant: 'danger', label: 'Failed' },
};

const attemptPill = (status: string) => {
  const s = ATTEMPT_STATUS[status] ?? { variant: 'neutral' as const, label: status };
  return <StatusPill variant={s.variant}>{s.label}</StatusPill>;
};

const sourceLabel = (source: string) => (source === '' ? '(no path)' : source);
/** UTC to the second, so the column reads the same for everyone. */
const time = (d: Date | null) => (d ? `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC` : '-');
const shortFingerprint = (fp: string) => (fp.length > 12 ? `${fp.slice(0, 12)}...` : fp);

export const adaptersRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const base = `/admin/accounts/${account.id}`;
  const shapes = await listShapes(c.get('deps').appDb, account.id);
  return c.html(
    <Layout title="Adapters" user={c.get('user')} csrf={c.get('csrf')}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <PageHeader
        breadcrumbs={[{ label: 'Accounts', href: '/admin' }, { label: account.slug, href: base }, { label: 'Adapters' }]}
        title="Adapters"
        description="The code the AI wrote for each data shape."
      />
      <Section title="Data shapes" flush>
        <DataTable
          caption="Adapters, one row per data shape"
          rows={shapes}
          empty={
            <EmptyState
              title="No adapters yet"
              description={
                <>
                  Send data and the AI writes one for each new shape. <a href={`${base}/connect`}>Connect</a>
                </>
              }
            />
          }
          columns={[
            {
              header: 'Source',
              cell: (s) => (
                <a class="row-link" href={`${base}/adapters/${s.currentId}`}>
                  {sourceLabel(s.source)}
                </a>
              ),
            },
            { header: 'Op', cell: (s) => s.op },
            {
              header: 'Fingerprint',
              mono: true,
              cell: (s) => <span title={s.fingerprint}>{shortFingerprint(s.fingerprint)}</span>,
            },
            {
              header: 'Status',
              cell: (s) => (
                <StatusPill variant={SHAPE_STATUS[s.status].variant}>{SHAPE_STATUS[s.status].label}</StatusPill>
              ),
            },
            { header: 'Version', align: 'right', cell: (s) => `v${s.currentVersion}` },
            { header: 'Versions', align: 'right', cell: (s) => s.versionCount },
            {
              header: 'Last attempt',
              cell: (s) =>
                s.lastAttemptStatus ? (
                  <>
                    {attemptPill(s.lastAttemptStatus)} <span class="muted">{time(s.lastAttemptAt)}</span>
                  </>
                ) : (
                  <span class="muted">None</span>
                ),
            },
            { header: 'Events', align: 'right', cell: (s) => s.eventCount },
          ]}
        />
      </Section>
    </Layout>,
  );
};

export const adapterRoute: Handler<AdminEnv> = async (c) => {
  const account = c.get('account')!;
  const adapterId = c.req.param('adapterId') ?? '';
  if (!isUuid(adapterId)) throw new HttpError(404, 'Page not found');
  const adapter = await getAdapterDetail(c.get('deps').appDb, account.id, adapterId);
  if (!adapter) throw new HttpError(404, 'Page not found');

  const base = `/admin/accounts/${account.id}`;
  const shape = `${sourceLabel(adapter.source)} / ${adapter.op}`;
  const status = SHAPE_STATUS[adapter.shapeStatus];
  return c.html(
    <Layout title={`Adapter ${shape}`} user={c.get('user')} csrf={c.get('csrf')}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <PageHeader
        breadcrumbs={[
          { label: 'Accounts', href: '/admin' },
          { label: account.slug, href: base },
          { label: 'Adapters', href: `${base}/adapters` },
          { label: shape },
        ]}
        title={
          <>
            {shape} <StatusPill variant={status.variant}>{status.label}</StatusPill>
          </>
        }
        description={`Version ${adapter.version} of the code the AI wrote for this data shape.`}
      />
      <Section title="Code" description="Runs in a sandbox. Turns each event of this shape into table rows.">
        <CodeBlock value={adapter.code} label="adapter code" />
      </Section>
      <Section title="Details">
        <dl class="adapter-details">
          <dt>Version</dt>
          <dd>{adapter.version}</dd>
          <dt>Fingerprint</dt>
          <dd class="mono">{adapter.fingerprint}</dd>
          <dt>Created</dt>
          <dd>{time(adapter.createdAt)}</dd>
          <dt>Validated</dt>
          <dd>{adapter.validatedAt ? time(adapter.validatedAt) : 'Not validated'}</dd>
          <dt>State</dt>
          <dd>
            {adapter.active
              ? 'Active'
              : adapter.supersededAt
                ? `Superseded ${time(adapter.supersededAt)}`
                : 'Not active'}
          </dd>
          {adapter.opaquePaths.length > 0 && (
            <>
              <dt>Opaque paths</dt>
              <dd class="mono">{adapter.opaquePaths.join(', ')}</dd>
            </>
          )}
        </dl>
      </Section>
      <Section title="Versions" flush>
        <DataTable
          caption="Versions of this adapter"
          rows={adapter.versions}
          columns={[
            {
              header: 'Version',
              cell: (v) =>
                v.id === adapter.id ? (
                  <strong>v{v.version} (viewing)</strong>
                ) : (
                  <a href={`${base}/adapters/${v.id}`}>v{v.version}</a>
                ),
            },
            {
              header: 'Status',
              cell: (v) => (
                <StatusPill variant={VERSION_STATUS[v.status].variant}>{VERSION_STATUS[v.status].label}</StatusPill>
              ),
            },
            { header: 'Created', cell: (v) => time(v.createdAt) },
          ]}
        />
      </Section>
      <Section title="Generation attempts" description={`Newest first, up to ${ATTEMPT_LIMIT}.`} flush>
        <DataTable
          caption="Generation attempts for this data shape"
          rows={adapter.attempts}
          empty={<EmptyState title="No attempts recorded" />}
          columns={[
            { header: 'Status', cell: (t) => attemptPill(t.status) },
            { header: 'Started', cell: (t) => time(t.startedAt) },
            { header: 'Finished', cell: (t) => time(t.finishedAt) },
            { header: 'Detail', mono: true, cell: (t) => t.detail ?? '-' },
          ]}
        />
      </Section>
      {adapter.extraFingerprints.length > 0 && (
        <Section title="Also used for" description="Other data shapes this adapter was reused for." flush>
          <DataTable
            caption="Additional fingerprints"
            rows={adapter.extraFingerprints}
            columns={[
              { header: 'Fingerprint', mono: true, cell: (f) => f.fingerprint },
              { header: 'Added', cell: (f) => time(f.createdAt) },
            ]}
          />
        </Section>
      )}
    </Layout>,
  );
};

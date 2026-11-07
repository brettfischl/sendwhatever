import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { Icon, type IconName } from './icons.js';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

// ---------- PageHeader ----------

export interface Crumb {
  label: string;
  href?: string;
}

/** The top of a page: optional breadcrumbs, a title, a description, and actions on the right. */
export const PageHeader: FC<{
  title: Child;
  description?: Child;
  actions?: Child;
  breadcrumbs?: Crumb[];
}> = ({ title, description, actions, breadcrumbs }) => (
  <header class="page-header">
    <div class="page-header-text">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol class="breadcrumbs">
            {breadcrumbs.map((crumb, i) => (
              <li>
                {i > 0 && <Icon name="chevron-right" size={14} />}
                {crumb.href ? <a href={crumb.href}>{crumb.label}</a> : <span>{crumb.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <h1>{title}</h1>
      {description && <p class="page-header-desc">{description}</p>}
    </div>
    {actions && <div class="page-header-actions">{actions}</div>}
  </header>
);

// ---------- Card / Section ----------

/** A plain surface. Same look as the legacy `.card` class. */
export const Card: FC<PropsWithChildren<{ class?: string; id?: string }>> = ({
  class: className,
  id,
  children,
}) => (
  <section class={cx('card', className)} id={id}>
    {children}
  </section>
);

/**
 * A titled card with an optional description and actions in its header. `flush` removes the body
 * padding, for a table that runs edge to edge.
 */
export const Section: FC<
  PropsWithChildren<{ title: Child; description?: Child; actions?: Child; flush?: boolean; id?: string }>
> = ({ title, description, actions, flush, id, children }) => (
  <section class="card section" id={id}>
    <div class="section-head">
      <div>
        <h2>{title}</h2>
        {description && <p class="section-desc">{description}</p>}
      </div>
      {actions && <div class="section-actions">{actions}</div>}
    </div>
    <div class={cx('section-body', flush && 'flush')}>{children}</div>
  </section>
);

// ---------- StatTile / StatGrid ----------

export const StatGrid: FC<PropsWithChildren> = ({ children }) => <div class="stat-grid">{children}</div>;

/** A label, a big number, and an optional hint. `trend` colors the hint. */
export const StatTile: FC<{
  label: Child;
  value: Child;
  hint?: Child;
  trend?: 'up' | 'down' | 'flat';
}> = ({ label, value, hint, trend }) => (
  <div class="stat">
    <div class="stat-label">{label}</div>
    <div class="stat-value">{value}</div>
    {hint !== undefined && <div class={cx('stat-hint', trend && trend !== 'flat' && trend)}>{hint}</div>}
  </div>
);

// ---------- StatusPill ----------

export type StatusVariant = 'neutral' | 'info' | 'progress' | 'success' | 'warning' | 'danger';

/** A small rounded status label with a colored dot. `progress` pulses, except under reduced motion. */
export const StatusPill: FC<PropsWithChildren<{ variant?: StatusVariant; dot?: boolean }>> = ({
  variant = 'neutral',
  dot = true,
  children,
}) => (
  <span class={`pill pill-${variant}`} data-variant={variant}>
    {dot && <span class="pill-dot" aria-hidden="true" />}
    {children}
  </span>
);

export type PipelineStatus = 'queued' | 'adapter_generating' | 'waiting' | 'quarantined' | 'written';

const PIPELINE_STATUS: Record<PipelineStatus, { variant: StatusVariant; label: string }> = {
  queued: { variant: 'neutral', label: 'Queued' },
  adapter_generating: { variant: 'progress', label: 'AI generating' },
  waiting: { variant: 'info', label: 'Waiting for adapter' },
  quarantined: { variant: 'warning', label: 'Needs attention' },
  written: { variant: 'success', label: 'Written' },
};

/** Maps a pipeline status to a pill variant and a human label. Unknown values show as-is, neutral. */
export function pipelineStatus(status: string): { variant: StatusVariant; label: string } {
  return PIPELINE_STATUS[status as PipelineStatus] ?? { variant: 'neutral', label: status };
}

/** Maps an account status (`active`, `provisioning`, `disabled`) to a pill variant. */
export function accountStatusVariant(status: string): StatusVariant {
  if (status === 'active') return 'success';
  if (status === 'provisioning') return 'progress';
  if (status === 'disabled') return 'neutral';
  return 'neutral';
}

// ---------- DataTable ----------

export interface Column<T> {
  /** Header text. */
  header: Child;
  /** Renders the cell. */
  cell: (row: T, index: number) => Child;
  align?: 'left' | 'right' | 'center';
  /** Monospace, smaller text, for ids, hashes, and code-like values. */
  mono?: boolean;
  /** A CSS width, such as '120px' or '30%'. */
  width?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Shown instead of the table when there are no rows. */
  empty?: Child;
  /** Accessible caption, visually hidden. */
  caption?: string;
}

/** A dense table from column definitions. Renders `empty` (or a plain message) when there are no rows. */
export function DataTable<T>({ columns, rows, empty, caption }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <div class="data-table-empty">{empty ?? <EmptyState title="Nothing here yet" />}</div>;
  }
  const cellClass = (col: Column<T>) =>
    cx(col.mono && 'mono', col.align && col.align !== 'left' && col.align) || undefined;
  return (
    <div class="table-wrap">
      <table class="data-table">
        {caption && <caption class="visually-hidden">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th scope="col" class={cx(col.align && col.align !== 'left' && col.align) || undefined} style={col.width ? `width:${col.width}` : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr>
              {columns.map((col) => (
                <td class={cellClass(col)}>{col.cell(row, i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- CodeBlock ----------

// Inline like the page's other handlers. Clipboard access needs HTTPS or localhost, so say so if it's missing.
const CODE_COPY_HANDLER = `var btn = this, label = btn.querySelector('span');
var code = btn.closest('.codeblock').querySelector('code').textContent;
var show = function (text) { label.textContent = text; setTimeout(function () { label.textContent = 'Copy'; }, 1500); };
if (!navigator.clipboard) { show('Select to copy'); return; }
navigator.clipboard.writeText(code).then(function () { show('Copied'); }, function () { show('Select to copy'); });`;

/** Monospace code with a copy button in the corner. */
export const CodeBlock: FC<{ value: string; label: string }> = ({ value, label }) => (
  <div class="codeblock">
    <pre>
      <code>{value}</code>
    </pre>
    <button
      type="button"
      class="btn btn-secondary btn-sm codeblock-copy"
      aria-label={`Copy ${label}`}
      onclick={CODE_COPY_HANDLER}
    >
      <Icon name="copy" size={14} />
      <span>Copy</span>
    </button>
  </div>
);

// ---------- EmptyState ----------

export const EmptyState: FC<{
  title: Child;
  description?: Child;
  icon?: IconName;
  action?: Child;
}> = ({ title, description, icon = 'inbox', action }) => (
  <div class="empty">
    <div class="empty-icon">
      <Icon name={icon} size={20} />
    </div>
    <p class="empty-title">{title}</p>
    {description && <p class="empty-desc">{description}</p>}
    {action && <div class="empty-action">{action}</div>}
  </div>
);

// ---------- Callout ----------

export type CalloutVariant = 'info' | 'success' | 'warning' | 'danger';

const CALLOUT_ICON: Record<CalloutVariant, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  danger: 'alert-circle',
};

export const Callout: FC<PropsWithChildren<{ variant?: CalloutVariant; title?: Child }>> = ({
  variant = 'info',
  title,
  children,
}) => (
  <div class={`callout callout-${variant}`} role={variant === 'danger' ? 'alert' : undefined}>
    <Icon name={CALLOUT_ICON[variant]} size={16} />
    <div class="callout-body">
      {title && <div class="callout-title">{title}</div>}
      {children && <div>{children}</div>}
    </div>
  </div>
);

// ---------- Button / LinkButton ----------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const buttonClass = (variant: ButtonVariant, size: ButtonSize, block?: boolean, extra?: string) =>
  cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', block && 'btn-block', extra);

export const Button: FC<
  PropsWithChildren<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    icon?: IconName;
    block?: boolean;
    name?: string;
    value?: string;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
    title?: string;
  }>
> = ({ variant = 'primary', size = 'md', type = 'submit', icon, block, class: className, children, ...rest }) => (
  <button type={type} class={buttonClass(variant, size, block, className)} {...rest}>
    {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    {children}
  </button>
);

export const LinkButton: FC<
  PropsWithChildren<{
    href: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: IconName;
    block?: boolean;
    class?: string;
    target?: string;
    rel?: string;
  }>
> = ({ href, variant = 'secondary', size = 'md', icon, block, class: className, children, ...rest }) => (
  <a href={href} class={buttonClass(variant, size, block, className)} {...rest}>
    {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    {children}
  </a>
);

// ---------- LinkCard ----------

/** A card that links somewhere, with an icon, a title, and a one-line description. */
export const LinkCard: FC<{ href: string; icon: IconName; title: Child; description: Child }> = ({
  href,
  icon,
  title,
  description,
}) => (
  <a class="link-card" href={href}>
    <span class="link-card-icon">
      <Icon name={icon} size={16} />
    </span>
    <span>
      <span class="link-card-title">{title}</span>
      <span class="link-card-desc">{description}</span>
    </span>
    <Icon name="chevron-right" size={16} class="link-card-chevron" />
  </a>
);

export const LinkGrid: FC<PropsWithChildren> = ({ children }) => <div class="link-grid">{children}</div>;

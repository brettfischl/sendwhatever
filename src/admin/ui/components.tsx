import type { Child, FC, PropsWithChildren } from 'hono/jsx';
import { Icon, type IconName } from './icons.js';
import { fullTime, relativeTime } from './format.js';
import { STATUS_LABELS } from '../../pipeline/labels.js';

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
 * padding, for a table that runs edge to edge. With no children it is header-only (no empty body, no
 * divider under the header). `compact` tightens the header and body padding.
 */
export const Section: FC<
  PropsWithChildren<{
    title: Child;
    description?: Child;
    actions?: Child;
    flush?: boolean;
    compact?: boolean;
    id?: string;
  }>
> = ({ title, description, actions, flush, compact, id, children }) => {
  const headerOnly = children === undefined || children === null || children === false;
  return (
    <section class={cx('card', 'section', compact && 'section-compact', headerOnly && 'section-header-only')} id={id}>
      <div class="section-head">
        <div>
          <h2>{title}</h2>
          {description && <p class="section-desc">{description}</p>}
        </div>
        {actions && <div class="section-actions">{actions}</div>}
      </div>
      {!headerOnly && <div class={cx('section-body', flush && 'flush')}>{children}</div>}
    </section>
  );
};

// ---------- StatTile / StatGrid ----------

export const StatGrid: FC<PropsWithChildren> = ({ children }) => <div class="stat-grid">{children}</div>;

/**
 * A label, a big number, and an optional hint. `trend` colors the hint. `tone` (neutral, info,
 * progress, success, warning or danger) colors the number when it isn't zero (a zero dims). `href` makes the tile a link, e.g. to a filtered list.
 */
export const StatTile: FC<{
  label: Child;
  value: Child;
  hint?: Child;
  trend?: 'up' | 'down' | 'flat';
  tone?: StatusVariant;
  href?: string;
}> = ({ label, value, hint, trend, tone, href }) => {
  const zero = value === 0 || value === '0';
  const body = (
    <>
      <div class="stat-label">{label}</div>
      <div class="stat-value">{value}</div>
      {hint !== undefined && <div class={cx('stat-hint', trend && trend !== 'flat' && trend)}>{hint}</div>}
    </>
  );
  const className = cx('stat', zero ? 'stat-zero' : tone && tone !== 'neutral' && `stat-${tone}`);
  return href ? (
    <a class={className} href={href}>
      {body}
    </a>
  ) : (
    <div class={className}>{body}</div>
  );
};

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

const PIPELINE_VARIANTS: Record<PipelineStatus, StatusVariant> = {
  queued: 'neutral',
  adapter_generating: 'progress',
  waiting: 'info',
  quarantined: 'warning',
  written: 'success',
};

/** Maps a pipeline status to a pill variant and the shared label (src/pipeline/labels.ts). Unknown values show as-is, neutral. */
export function pipelineStatus(status: string): { variant: StatusVariant; label: string } {
  const known = status in PIPELINE_VARIANTS;
  return known
    ? { variant: PIPELINE_VARIANTS[status as PipelineStatus], label: STATUS_LABELS[status as PipelineStatus] }
    : { variant: 'neutral', label: status };
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
  /**
   * Makes the whole row clickable. Keep a real link in one cell for keyboard and screen readers; the
   * row click is a mouse convenience on top of it and ignores clicks on links, buttons and selections.
   */
  rowHref?: (row: T) => string;
  /** Extra attributes for each row's `<tr>`, e.g. a `data-*` hook for tests or scripts. */
  rowAttrs?: (row: T) => Record<string, string | undefined>;
}

const ROW_CLICK_HANDLER = `if (event.target.closest('a, button, input, select, textarea')) return;
if (String(window.getSelection())) return;
if (event.metaKey || event.ctrlKey) { window.open(this.dataset.href, '_blank'); return; }
location.href = this.dataset.href;`;

/** A dense table from column definitions. Renders `empty` (or a plain message) when there are no rows. */
export function DataTable<T>({ columns, rows, empty, caption, rowHref, rowAttrs }: DataTableProps<T>) {
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
            <tr
              {...rowAttrs?.(row)}
              class={rowHref ? 'row-link' : undefined}
              data-href={rowHref?.(row)}
              onclick={rowHref ? ROW_CLICK_HANDLER : undefined}
            >
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

// ---------- KeyValueList ----------

/** Labels and values as a definition list, for the details of one thing. */
export const KeyValueList: FC<{
  items: { label: Child; value: Child; attrs?: Record<string, string> }[];
}> = ({ items }) => (
  <dl class="kv">
    {items.map((item) => (
      <>
        <dt>{item.label}</dt>
        <dd {...item.attrs}>{item.value}</dd>
      </>
    ))}
  </dl>
);

// ---------- Toolbar ----------

/** A compact bar for filters and actions. Put forms, selects, inputs and buttons inside it. */
export const Toolbar: FC<PropsWithChildren<{ label?: string; attrs?: Record<string, string> }>> = ({
  label,
  attrs,
  children,
}) => (
  <div class="toolbar" role="group" aria-label={label} {...attrs}>
    {children}
  </div>
);

// ---------- RelativeTime ----------

/** "5m ago" with the full UTC timestamp as a tooltip and a machine-readable datetime. */
export const RelativeTime: FC<{ value: Date | string; now?: Date }> = ({ value, now }) => {
  const iso = typeof value === 'string' ? value : value.toISOString();
  return (
    <time datetime={iso} title={fullTime(value)}>
      {relativeTime(value, now)}
    </time>
  );
};

// ---------- CodeBlock ----------

// Inline like the page's other handlers. Clipboard access needs HTTPS or localhost, so say so if it's missing.
const CODE_COPY_HANDLER = `var btn = this, label = btn.querySelector('span');
var code = btn.closest('.codeblock').querySelector('code').textContent;
var show = function (text) { label.textContent = text; setTimeout(function () { label.textContent = 'Copy'; }, 1500); };
if (!navigator.clipboard) { show('Select to copy'); return; }
navigator.clipboard.writeText(code).then(function () { show('Copied'); }, function () { show('Select to copy'); });`;

/**
 * Monospace code with a copy button in the corner. `caption` is a small label above the block.
 * `overflow` decides what a long line does: `wrap` (default) breaks it inside the block, `scroll` keeps
 * it on one line and scrolls horizontally.
 */
export const CodeBlock: FC<{ value: string; label: string; caption?: Child; overflow?: 'wrap' | 'scroll' }> = ({
  value,
  label,
  caption,
  overflow = 'wrap',
}) => (
  <div class="codeblock">
    {caption && <p class="codeblock-caption">{caption}</p>}
    <div class={cx('codeblock-box', overflow === 'scroll' && 'codeblock-scroll')}>
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
  </div>
);

// ---------- EmptyState ----------

export const EmptyState: FC<{
  title: Child;
  description?: Child;
  icon?: IconName;
  action?: Child;
  /** Less padding and a smaller icon, for use inside a table or a section. */
  compact?: boolean;
}> = ({ title, description, icon = 'inbox', action, compact }) => (
  <div class={cx('empty', compact && 'empty-compact')}>
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

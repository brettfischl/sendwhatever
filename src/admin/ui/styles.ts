import { createHash } from 'node:crypto';

/**
 * The admin stylesheet, served at /admin/assets/app.css. It lives in a TypeScript module so there is
 * no build step and no file serving. Colors are tokens on :root, so a dark theme can be added later
 * by redefining them.
 */
export const CSS = `
:root {
  /* Neutrals: slate */
  --gray-0: #ffffff;
  --gray-25: #fbfcfd;
  --gray-50: #f8fafc;
  --gray-100: #f1f5f9;
  --gray-150: #e9eef4;
  --gray-200: #e2e8f0;
  --gray-300: #cbd5e1;
  --gray-400: #94a3b8;
  --gray-500: #64748b;
  --gray-600: #475569;
  --gray-700: #334155;
  --gray-800: #1e293b;
  --gray-900: #0f172a;

  /* Surfaces and text */
  --bg: var(--gray-50);
  --surface: var(--gray-0);
  --surface-sunken: var(--gray-50);
  --surface-hover: var(--gray-100);
  --border: var(--gray-200);
  --border-strong: var(--gray-300);
  --text: var(--gray-900);
  --text-secondary: var(--gray-600);
  --text-tertiary: var(--gray-500);

  /* Accent: the existing blue, refined */
  --accent: #2346d8;
  --accent-hover: #1c39b8;
  --accent-active: #182f96;
  --accent-soft: #eef2fe;
  --accent-soft-border: #c9d4fa;
  --accent-contrast: #ffffff;
  --focus-ring: 0 0 0 3px rgba(35, 70, 216, 0.28);

  /* Semantic */
  --success: #15803d;  --success-soft: #ecfdf3; --success-border: #bbe5c9;
  --warning: #b45309;  --warning-soft: #fffbeb; --warning-border: #f6dca2;
  --danger: #c62a3a;   --danger-soft: #fef2f3;  --danger-border: #f5c2c8;
  --info: #0369a1;     --info-soft: #f0f9ff;    --info-border: #bae0f7;
  --progress: #6d28d9; --progress-soft: #f5f3ff; --progress-border: #d9cdfa;
  --live: #d92d3f;

  /* Spacing: 4/8 scale */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px;

  /* Radius and shadows */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-full: 999px;
  --shadow-1: 0 1px 2px rgba(15, 23, 42, 0.05);
  --shadow-2: 0 1px 3px rgba(15, 23, 42, 0.06), 0 6px 16px -4px rgba(15, 23, 42, 0.08);

  /* Type */
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  --text-xs: 12px; --text-sm: 13px; --text-md: 14px; --text-lg: 16px; --text-xl: 20px; --text-2xl: 24px;

  --sidebar-width: 240px;
  --content-max: 1100px;

  /* Legacy names used by page-local styles until the migration (sw-rb2.14) */
  --ink: var(--text);
  --muted: var(--text-secondary);
  --line: var(--border);
  --paper: var(--surface-sunken);
  --card: var(--surface);
  --accent-ink: var(--accent-contrast);
  --ok: var(--success);
  --warn: var(--warning);

  color-scheme: light;
  font-family: var(--font-sans);
  font-size: var(--text-md);
  line-height: 1.5;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: var(--text-md); }

/* ---------- Base elements ---------- */
h1, h2, h3, h4 { color: var(--text); font-weight: 600; letter-spacing: -0.011em; }
h1 { font-size: var(--text-2xl); line-height: 1.25; margin: 0 0 var(--space-2); letter-spacing: -0.02em; }
h2 { font-size: var(--text-lg); line-height: 1.4; margin: 0 0 var(--space-3); }
h3 { font-size: var(--text-md); line-height: 1.4; margin: 0 0 var(--space-2); }
h2 code, h1 code { font-size: 0.9em; }
p { margin: 0 0 var(--space-3); }
p:last-child { margin-bottom: 0; }
strong { font-weight: 600; }
a { color: var(--accent); text-decoration: none; text-underline-offset: 2px; }
a:hover { color: var(--accent-hover); text-decoration: underline; }
hr { border: 0; border-top: 1px solid var(--border); margin: var(--space-4) 0; }
svg { flex: none; }

code, pre, kbd, samp { font-family: var(--font-mono); }
code { font-size: 0.875em; overflow-wrap: anywhere; }
:not(pre) > code { background: var(--gray-100); border: 1px solid var(--gray-150); border-radius: 4px; padding: 0.1em 0.35em; color: var(--gray-800); }
pre { margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4); white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--text-sm); line-height: 1.6; background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--gray-800); }
pre code { font-size: inherit; }

/* Tables: dense rows, subtle header, row borders, hover */
table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: var(--space-2) var(--space-3); border-top: 1px solid var(--border); vertical-align: middle; }
thead th { border-top: 0; border-bottom: 1px solid var(--border); background: var(--surface-sunken); color: var(--text-tertiary); font-size: var(--text-xs); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
thead + tbody tr:first-child td, thead + tbody tr:first-child th { border-top: 0; }
tbody tr:hover > td, tbody tr:hover > th { background: var(--gray-25); }
tfoot th, tfoot td { color: var(--text-secondary); font-weight: 500; background: var(--surface-sunken); }
th.num, td.num { text-align: right; }
.card > table, .card > [data-live-region] > table { margin-top: var(--space-2); }

/* Forms */
label { display: grid; gap: 6px; font-size: var(--text-sm); font-weight: 500; color: var(--gray-700); }
input, select, textarea { font: inherit; font-size: var(--text-md); color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 7px 10px; min-height: 36px; box-shadow: var(--shadow-1); transition: border-color 120ms ease, box-shadow 120ms ease; }
input, textarea { width: 100%; }
input::placeholder, textarea::placeholder { color: var(--gray-400); }
input:hover, select:hover, textarea:hover { border-color: var(--gray-400); }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
input[type='checkbox'], input[type='radio'] { width: auto; min-height: 0; box-shadow: none; accent-color: var(--accent); }

button, .btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: var(--text-sm); font-weight: 500; line-height: 20px; white-space: nowrap;
  min-height: 34px; padding: 6px 14px; cursor: pointer; text-decoration: none;
  color: var(--accent-contrast); background: var(--accent); border: 1px solid var(--accent); border-radius: var(--radius-sm);
  box-shadow: var(--shadow-1), inset 0 1px 0 rgba(255, 255, 255, 0.12);
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
button:hover, .btn:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-contrast); text-decoration: none; }
button:active, .btn:active { background: var(--accent-active); }
button:disabled, .btn[aria-disabled='true'] { opacity: 0.55; cursor: not-allowed; }
button.quiet, .btn-secondary { color: var(--gray-800); background: var(--surface); border-color: var(--border-strong); box-shadow: var(--shadow-1); }
button.quiet { min-height: 30px; padding: 4px 10px; }
button.quiet:hover, .btn-secondary:hover { color: var(--text); background: var(--surface-hover); border-color: var(--gray-400); }
button.quiet:active, .btn-secondary:active { background: var(--gray-150); }
.btn-danger { color: #fff; background: var(--danger); border-color: var(--danger); }
.btn-danger:hover { color: #fff; background: #a92231; border-color: #a92231; }
.btn-danger:active { background: #8f1d2a; }
.btn-ghost { color: var(--text-secondary); background: transparent; border-color: transparent; box-shadow: none; }
.btn-ghost:hover { color: var(--text); background: var(--surface-hover); border-color: transparent; }
.btn-ghost:active { background: var(--gray-150); }
.btn-sm { min-height: 28px; padding: 3px 10px; font-size: var(--text-xs); gap: 4px; }
.btn-block { width: 100%; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: none; }
button:focus-visible, .btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }

/* ---------- Existing classes ---------- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-5) var(--space-6); min-width: 0; box-shadow: var(--shadow-1); }
.card > h2:first-child { margin-bottom: var(--space-3); }
.card > h1:first-child + p.muted { margin-top: calc(-1 * var(--space-1)); }
.narrow { max-width: 400px; width: 100%; }
.muted { color: var(--text-secondary); font-size: var(--text-sm); }
.error { color: var(--danger); font-weight: 500; }
p.error { padding: var(--space-2) var(--space-3); background: var(--danger-soft); border: 1px solid var(--danger-border); border-radius: var(--radius-sm); font-size: var(--text-sm); }
.form { display: grid; gap: var(--space-4); }
.form > button, .form > .btn { justify-self: start; }
form { margin: 0; }

ul.list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: grid; }
ul.list:last-child { margin-bottom: 0; }
ul.list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); padding: 10px 0; border-top: 1px solid var(--border); min-height: 44px; }
ul.list li:first-child { border-top: 0; padding-top: var(--space-1); }
ul.list li > code { min-width: 0; text-align: right; }
ul.list li > span { min-width: 0; display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
ul.list li > .copy { flex: 1 1 16rem; width: auto; min-width: 0; margin: 0; }
ul.list form { display: inline-flex; align-items: center; gap: var(--space-2); }
ul.list input { width: auto; min-width: 0; min-height: 30px; padding: 4px 8px; font-size: var(--text-sm); }

.copy { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); width: 100%; margin: 0 0 var(--space-3); padding: 10px var(--space-3); text-align: left; font-weight: 400; color: var(--text); background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: none; user-select: text; }
.copy:hover { background: var(--surface-sunken); border-color: var(--border-strong); color: var(--text); }
.copy code { flex: 1; min-width: 0; white-space: pre-wrap; background: none; border: 0; padding: 0; }
.copy-hint { flex: none; font-size: var(--text-xs); font-weight: 500; color: var(--accent); user-select: none; }

.tag, .pill {
  display: inline-flex; align-items: center; gap: 6px; vertical-align: middle;
  height: 22px; padding: 0 8px; border-radius: var(--radius-full);
  font-family: var(--font-sans); font-size: var(--text-xs); font-weight: 500; line-height: 1; letter-spacing: 0; white-space: nowrap;
  color: var(--gray-700); background: var(--gray-100); border: 1px solid var(--gray-200);
}
h1 .tag, h2 .tag, h1 .pill, h2 .pill { margin-left: var(--space-1); }
.tag.active, .pill-success { color: var(--success); background: var(--success-soft); border-color: var(--success-border); }
.tag.provisioning, .pill-progress { color: var(--progress); background: var(--progress-soft); border-color: var(--progress-border); }
.pill-danger { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-border); }
.pill-info { color: var(--info); background: var(--info-soft); border-color: var(--info-border); }
.pill-warning { color: var(--warning); background: var(--warning-soft); border-color: var(--warning-border); }
.pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.pill-progress .pill-dot { animation: sw-pulse 1.6s ease-in-out infinite; }
@keyframes sw-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }

/* ---------- App shell ---------- */
.shell { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4) var(--space-3); background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; }
.brand { display: inline-flex; align-items: center; gap: 10px; padding: 6px var(--space-2); color: var(--text); font-size: 15px; font-weight: 650; letter-spacing: -0.02em; text-decoration: none; }
.brand:hover { color: var(--text); text-decoration: none; }
.brand-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px rgba(217, 45, 63, 0.18); flex: none; }
.brand-sub { font-size: var(--text-xs); font-weight: 500; color: var(--text-tertiary); letter-spacing: 0; padding: 1px 6px; border: 1px solid var(--border); border-radius: var(--radius-full); }

.side-account { display: grid; gap: var(--space-2); padding: var(--space-3); background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius-md); }
.side-account-label { font-size: var(--text-xs); color: var(--text-tertiary); font-weight: 500; }
.side-account-slug { font-weight: 600; font-size: var(--text-md); color: var(--text); overflow-wrap: anywhere; line-height: 1.3; }
.side-account-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.side-account-switch { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); font-weight: 500; color: var(--text-secondary); }
.side-account-switch:hover { color: var(--accent); text-decoration: none; }

.nav { display: grid; gap: 2px; }
.nav-title { padding: 0 var(--space-2); margin: 0 0 var(--space-1); font-size: var(--text-xs); font-weight: 500; color: var(--text-tertiary); }
.nav-item { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 6px var(--space-2); border-radius: var(--radius-sm); color: var(--gray-700); font-size: var(--text-md); font-weight: 500; text-decoration: none; white-space: nowrap; }
.nav-item svg { color: var(--gray-500); }
.nav-item:hover { color: var(--text); background: var(--surface-hover); text-decoration: none; }
.nav-item:hover svg { color: var(--gray-700); }
.nav-item[aria-current='page'] { color: var(--accent); background: var(--accent-soft); }
.nav-item[aria-current='page'] svg { color: var(--accent); }

.side-user { margin-top: auto; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-2) 0; border-top: 1px solid var(--border); }
.avatar { display: inline-grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 50%; background: var(--gray-150); color: var(--gray-700); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; }
.side-user-text { display: grid; min-width: 0; flex: 1; line-height: 1.3; }
.side-user-email { font-size: var(--text-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-user-role { font-size: var(--text-xs); color: var(--text-tertiary); }
.side-user form { display: contents; }
.side-user .btn-ghost { padding: 0; width: 30px; min-height: 30px; }

.main { min-width: 0; }
main.content { display: grid; gap: var(--space-4); align-content: start; width: 100%; max-width: calc(var(--content-max) + 2 * var(--space-8)); padding: var(--space-8); }
main.content > *, [data-live-region] > * { min-width: 0; }
[data-live-region] { display: grid; gap: var(--space-4); min-width: 0; }
/* A bare message in a live region (e.g. "No tables yet") reads as an empty panel. */
[data-live-region] > p.muted:only-child { margin: 0; padding: var(--space-8) var(--space-6); text-align: center; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: var(--radius-md); }

@media (max-width: 900px) {
  .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
  .sidebar { position: sticky; top: 0; z-index: 10; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; align-content: flex-start; gap: var(--space-2) var(--space-3); padding: var(--space-2) var(--space-4); border-right: 0; border-bottom: 1px solid var(--border); overflow: visible; }
  .brand { padding: 4px 0; }
  .side-account { order: 2; display: flex; align-items: center; flex-wrap: wrap; gap: 6px var(--space-2); padding: 0; background: none; border: 0; min-width: 0; }
  .side-account-label { display: none; }
  .side-account-slug { font-size: var(--text-sm); }
  .side-account-slug::before { content: '/'; color: var(--gray-300); margin-right: var(--space-2); font-weight: 400; }
  .side-user { order: 3; margin: 0 0 0 auto; padding: 0; border: 0; }
  .side-user-text { display: none; }
  .side-navs { order: 4; flex-basis: 100%; display: flex; gap: var(--space-1); overflow-x: auto; margin: 0 calc(-1 * var(--space-4)); padding: 0 var(--space-4) 2px; scrollbar-width: none; }
  .side-navs::-webkit-scrollbar { display: none; }
  .nav { display: flex; gap: 2px; }
  .nav + .nav { padding-left: var(--space-2); border-left: 1px solid var(--border); }
  .nav-title { display: none; }
  .nav-item { font-size: var(--text-sm); min-height: 30px; padding: 4px var(--space-2); gap: 6px; }
  main.content { padding: var(--space-5) var(--space-4) var(--space-10); }
  .card { padding: var(--space-4); }
}
@media (min-width: 901px) { .side-navs { display: grid; gap: var(--space-5); } }

/* Logged-out pages: centered, no sidebar */
.centered { min-height: 100vh; display: grid; place-items: center; align-content: center; gap: var(--space-6); padding: var(--space-10) var(--space-4); }
.centered > main { width: 100%; max-width: 400px; display: grid; gap: var(--space-4); }
.centered .narrow { max-width: none; }
.auth-brand { display: flex; justify-content: center; }
.auth-card { padding: var(--space-8); box-shadow: var(--shadow-2); }
.auth-card h1 { font-size: var(--text-xl); margin-bottom: var(--space-1); }
.auth-foot { text-align: center; font-size: var(--text-xs); color: var(--text-tertiary); }

/* ---------- Components ---------- */
.page-header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-3) var(--space-4); margin-bottom: var(--space-2); }
.page-header-text { min-width: 0; display: grid; gap: var(--space-1); }
.page-header h1 { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.page-header-desc { margin: 0; color: var(--text-secondary); font-size: var(--text-md); }
.page-header-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.breadcrumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 0 0 var(--space-1); padding: 0; list-style: none; font-size: var(--text-sm); color: var(--text-tertiary); }
.breadcrumbs li { display: inline-flex; align-items: center; gap: 2px; }
.breadcrumbs a { color: var(--text-secondary); }
.breadcrumbs a:hover { color: var(--text); }
.breadcrumbs svg { color: var(--gray-400); }

.section { padding: 0; overflow: hidden; }
.section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-4); padding: var(--space-4) var(--space-6); border-bottom: 1px solid var(--border); }
.section-head h2 { margin: 0; font-size: var(--text-md); }
.section-desc { margin: 2px 0 0; font-size: var(--text-sm); color: var(--text-secondary); }
.section-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.section-body { padding: var(--space-5) var(--space-6); }
.section-body.flush { padding: 0; }
.section-body.flush table th:first-child, .section-body.flush table td:first-child { padding-left: var(--space-6); }
.section-body.flush table th:last-child, .section-body.flush table td:last-child { padding-right: var(--space-6); }

.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-4); }
.stat { display: grid; gap: var(--space-1); padding: var(--space-4) var(--space-5); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-1); min-width: 0; }
.stat-label { font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); }
.stat-value { font-size: var(--text-2xl); font-weight: 600; line-height: 1.2; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat-hint { font-size: var(--text-xs); color: var(--text-tertiary); }
.stat-hint.up { color: var(--success); }
.stat-hint.down { color: var(--danger); }

.table-wrap { overflow-x: auto; }
td.mono, th.mono { font-family: var(--font-mono); font-size: var(--text-xs); }
td.right, th.right { text-align: right; }
td.center, th.center { text-align: center; }
.data-table td a { font-weight: 500; }

.codeblock { position: relative; margin: 0 0 var(--space-3); }
.codeblock:last-child { margin-bottom: 0; }
.codeblock pre { margin: 0; padding-right: 88px; min-height: 42px; }
.codeblock-copy { position: absolute; top: 6px; right: 6px; }

.empty { display: grid; justify-items: center; gap: var(--space-2); padding: var(--space-10) var(--space-6); text-align: center; }
.empty-icon { display: grid; place-items: center; width: 40px; height: 40px; margin-bottom: var(--space-1); border-radius: var(--radius-md); background: var(--surface-sunken); border: 1px solid var(--border); color: var(--gray-500); }
.empty-title { margin: 0; font-size: var(--text-md); font-weight: 600; }
.empty-desc { margin: 0; max-width: 380px; color: var(--text-secondary); font-size: var(--text-sm); }
.empty-action { margin-top: var(--space-2); }

.callout { display: flex; gap: 10px; align-items: flex-start; padding: var(--space-3) var(--space-4); border: 1px solid; border-radius: var(--radius-sm); font-size: var(--text-sm); }
.callout svg { margin-top: 1px; }
.callout-body { min-width: 0; display: grid; gap: 2px; color: var(--text); }
.callout-title { font-weight: 600; }
.callout-info { background: var(--info-soft); border-color: var(--info-border); }
.callout-info > svg { color: var(--info); }
.callout-success { background: var(--success-soft); border-color: var(--success-border); }
.callout-success > svg { color: var(--success); }
.callout-warning { background: var(--warning-soft); border-color: var(--warning-border); }
.callout-warning > svg { color: var(--warning); }
.callout-danger { background: var(--danger-soft); border-color: var(--danger-border); }
.callout-danger > svg { color: var(--danger); }

.link-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-4); }
.link-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: var(--space-3); padding: var(--space-4) var(--space-5); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-1); text-decoration: none; transition: border-color 120ms ease, box-shadow 120ms ease; }
.link-card:hover { color: var(--text); text-decoration: none; border-color: var(--border-strong); box-shadow: var(--shadow-2); }
.link-card-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent); }
.link-card-title { display: block; font-weight: 600; margin: 4px 0 2px; }
.link-card-desc { display: block; font-size: var(--text-sm); color: var(--text-secondary); line-height: 1.45; }
.link-card-chevron { margin-top: 6px; color: var(--gray-400); transition: transform 120ms ease, color 120ms ease; }
.link-card:hover .link-card-chevron { color: var(--gray-600); transform: translateX(2px); }

.icon { display: inline-block; vertical-align: middle; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
  .pill-progress .pill-dot { animation: none; }
}
`;

/** A short content hash, so a changed stylesheet gets a new URL and the long cache is safe. */
export const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 10);

export const STYLESHEET_PATH = '/admin/assets/app.css';
export const STYLESHEET_HREF = `${STYLESHEET_PATH}?v=${CSS_VERSION}`;

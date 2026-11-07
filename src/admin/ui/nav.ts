import type { IconName } from './icons.js';

export type NavKey =
  | 'accounts'
  | 'overview'
  | 'connect'
  | 'credentials'
  | 'schema'
  | 'traffic'
  | 'pipeline'
  | 'manage-accounts'
  | 'manage-users';

export interface NavItem {
  key: NavKey;
  label: string;
  icon: IconName;
  href: string;
}

const ACCOUNT_SECTIONS = ['connect', 'credentials', 'schema', 'traffic', 'pipeline'] as const;

/** The account nav, in sidebar order. */
export function accountNav(accountId: string): NavItem[] {
  const base = `/admin/accounts/${accountId}`;
  return [
    { key: 'overview', label: 'Overview', icon: 'home', href: base },
    { key: 'connect', label: 'Connect', icon: 'plug', href: `${base}/connect` },
    { key: 'credentials', label: 'Credentials', icon: 'key', href: `${base}/credentials` },
    { key: 'schema', label: 'Schema', icon: 'table', href: `${base}/schema` },
    { key: 'traffic', label: 'Traffic', icon: 'activity', href: `${base}/traffic` },
    { key: 'pipeline', label: 'Pipeline', icon: 'workflow', href: `${base}/pipeline` },
  ];
}

export const MANAGE_NAV: NavItem[] = [
  { key: 'manage-accounts', label: 'Accounts', icon: 'building', href: '/admin/manage/accounts' },
  { key: 'manage-users', label: 'Users', icon: 'users', href: '/admin/manage/users' },
];

/**
 * Which sidebar item a path belongs to. Event pages (`.../events/...`) count as Pipeline, and any
 * deeper page under a section (e.g. `/credentials/keys`) counts as that section.
 */
export function activeNav(path: string): NavKey | undefined {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'admin') return undefined;
  if (parts.length === 1) return 'accounts';
  if (parts[1] === 'manage') {
    if (parts[2] === 'accounts') return 'manage-accounts';
    if (parts[2] === 'users') return 'manage-users';
    return undefined;
  }
  if (parts.includes('events')) return 'pipeline';
  if (parts[1] === 'accounts' && parts[2]) {
    const section = parts[3];
    if (section === undefined) return 'overview';
    return (ACCOUNT_SECTIONS as readonly string[]).includes(section) ? (section as NavKey) : undefined;
  }
  return undefined;
}

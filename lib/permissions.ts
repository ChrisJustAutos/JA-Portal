// lib/permissions.ts
// Role → permission mapping. Shared between client (for UI gating) and server (for API gating).
// Source of truth — if you add a new feature, add its permission here first.

export type UserRole = 'admin' | 'manager' | 'sales' | 'accountant' | 'viewer'

export const ROLE_LABELS: Record<UserRole, string> = {
  admin:      'Admin',
  manager:    'Manager',
  sales:      'Sales',
  accountant: 'Accountant',
  viewer:     'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin:      'Full access including user management and settings',
  manager:    'All data, cannot manage users or settings',
  sales:      'Leads/Orders, read-only distributors',
  accountant: 'P&L, invoices, payables, reports',
  viewer:     'Read-only view of dashboards',
}

// Permission strings — keep these stable once used. Client code checks them by name.
export type Permission =
  // Data views
  | 'view:dashboards'
  | 'view:overview'
  | 'view:invoices'
  | 'view:pnl'
  | 'view:stock'
  | 'view:payables'
  | 'view:leads'
  | 'view:distributors'
  | 'view:reports'
  // Actions
  | 'edit:any'
  | 'edit:distributors_groups'
  | 'edit:vin_codes'
  | 'edit:leads'
  | 'generate:reports'
  // Admin
  | 'admin:users'
  | 'admin:settings'
  | 'admin:audit_log'

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:reports',
    'edit:any','edit:distributors_groups','edit:vin_codes','edit:leads','generate:reports',
    'admin:users','admin:settings','admin:audit_log',
  ],
  manager: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:reports',
    'edit:leads','generate:reports',
  ],
  sales: [
    'view:dashboards','view:overview','view:leads','view:distributors','view:reports',
    'edit:leads','generate:reports',
  ],
  accountant: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:payables','view:reports',
    'generate:reports',
  ],
  viewer: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:reports',
  ],
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}

// For client-side UI: which sidebar sections should be visible to this role?
// Returns the nav item IDs to SHOW. Uses the same IDs as PortalSidebar.
export function visibleNavSections(role: UserRole): string[] {
  const visible: string[] = []
  if (roleHasPermission(role, 'view:leads'))         visible.push('leads')
  if (roleHasPermission(role, 'view:distributors'))  visible.push('distributors')
  if (roleHasPermission(role, 'view:reports'))       visible.push('reports')
  if (roleHasPermission(role, 'view:overview'))      visible.push('overview')
  if (roleHasPermission(role, 'view:invoices'))      visible.push('invoices')
  if (roleHasPermission(role, 'view:pnl'))           visible.push('pnl')
  if (roleHasPermission(role, 'view:stock'))         visible.push('stock')
  if (roleHasPermission(role, 'view:payables'))      visible.push('payables')
  if (roleHasPermission(role, 'admin:settings'))     visible.push('settings')
  return visible
}

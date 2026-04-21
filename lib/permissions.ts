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
  | 'view:todos'
  | 'view:jobs'
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
    'view:leads','view:distributors','view:reports','view:todos','view:jobs',
    'edit:any','edit:distributors_groups','edit:vin_codes','edit:leads','generate:reports',
    'admin:users','admin:settings','admin:audit_log',
  ],
  manager: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:reports','view:todos','view:jobs',
    'edit:leads','generate:reports',
  ],
  sales: [
    'view:dashboards','view:overview','view:leads','view:distributors','view:reports',
    'edit:leads','generate:reports',
  ],
  accountant: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:payables','view:reports',
    'view:jobs',
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

// ── Report type access ────────────────────────────────────────────────
// Each report type has an allow-list of roles that can generate it.
// Use this to filter which report types appear in the Reports picker for a given user.

export type ReportType =
  | 'monthly-management'
  | 'executive-summary'
  | 'distributor-performance'
  | 'cash-flow'
  | 'stock-health'
  | 'sales-pipeline'

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  'monthly-management':     'Monthly Management Report',
  'executive-summary':      'Executive Summary',
  'distributor-performance':'Distributor Performance Review',
  'cash-flow':              'Cash Flow / Working Capital',
  'stock-health':           'Stock Health',
  'sales-pipeline':         'Sales Pipeline',
}

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  'monthly-management':     'Full P&L, KPIs, receivables, stock summary and AI narrative. For monthly management meetings.',
  'executive-summary':      'One-page snapshot with top-line numbers and trend charts. For quick briefings.',
  'distributor-performance':'Ranked distributor revenue with bucket breakdowns and trends. For commercial reviews.',
  'cash-flow':              'Receivables aging, payables aging, cash position. For cash management.',
  'stock-health':           'Reorder alerts, dead stock, velocity analysis. For inventory planning.',
  'sales-pipeline':         'Open quotes, orders, conversion rates by rep. For sales reviews.',
}

const REPORT_TYPE_ROLES: Record<ReportType, UserRole[]> = {
  'monthly-management':     ['admin', 'manager'],
  'executive-summary':      ['admin', 'manager'],
  'distributor-performance':['admin', 'manager', 'sales'],
  'cash-flow':              ['admin', 'accountant'],
  'stock-health':           ['admin', 'manager'],
  'sales-pipeline':         ['admin', 'manager', 'sales'],
}

export function roleCanGenerateReportType(role: UserRole, type: ReportType): boolean {
  return REPORT_TYPE_ROLES[type]?.includes(role) ?? false
}

export function reportTypesForRole(role: UserRole): ReportType[] {
  return (Object.keys(REPORT_TYPE_ROLES) as ReportType[])
    .filter(t => roleCanGenerateReportType(role, t))
}

// For client-side UI: which sidebar sections should be visible to this role?
// Returns the nav item IDs to SHOW. Uses the same IDs as PortalSidebar.
export function visibleNavSections(role: UserRole): string[] {
  const visible: string[] = []
  if (roleHasPermission(role, 'view:leads'))         visible.push('leads')
  if (roleHasPermission(role, 'view:distributors'))  visible.push('distributors')
  if (roleHasPermission(role, 'view:reports'))       visible.push('reports')
  if (roleHasPermission(role, 'view:todos'))         visible.push('todos')
  if (roleHasPermission(role, 'view:jobs'))          visible.push('jobs')
  if (roleHasPermission(role, 'view:overview'))      visible.push('overview')
  if (roleHasPermission(role, 'view:invoices'))      visible.push('invoices')
  if (roleHasPermission(role, 'view:pnl'))           visible.push('pnl')
  if (roleHasPermission(role, 'view:stock'))         visible.push('stock')
  if (roleHasPermission(role, 'view:payables'))      visible.push('payables')
  if (roleHasPermission(role, 'admin:settings'))     visible.push('settings')
  return visible
}

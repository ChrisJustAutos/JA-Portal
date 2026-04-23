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
  | 'view:calls'
  | 'view:reports'
  | 'view:todos'
  | 'view:supplier_invoices'
  | 'view:jobs'
  | 'view:vehicle_sales'
  // Actions
  | 'edit:any'
  | 'edit:distributors_groups'
  | 'edit:vin_codes'
  | 'edit:leads'
  | 'edit:supplier_invoices'
  | 'generate:reports'
  // Admin
  | 'admin:users'
  | 'admin:settings'
  | 'admin:audit_log'

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports','view:todos','view:supplier_invoices',
    'view:jobs','view:vehicle_sales',
    'edit:any','edit:distributors_groups','edit:vin_codes','edit:leads','edit:supplier_invoices','generate:reports',
    'admin:users','admin:settings','admin:audit_log',
  ],
  manager: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports','view:todos','view:supplier_invoices',
    'view:jobs','view:vehicle_sales',
    'edit:leads','edit:supplier_invoices','generate:reports',
  ],
  sales: [
    'view:dashboards','view:overview','view:leads','view:distributors','view:calls','view:reports',
    'edit:leads','generate:reports',
  ],
  accountant: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:payables','view:reports',
    'view:supplier_invoices','edit:supplier_invoices',
    'view:jobs','view:vehicle_sales',
    'generate:reports',
  ],
  viewer: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports',
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
  | 'call-analytics'

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  'monthly-management':     'Monthly Management Report',
  'executive-summary':      'Executive Summary',
  'distributor-performance':'Distributor Performance Review',
  'cash-flow':              'Cash Flow / Working Capital',
  'stock-health':           'Stock Health',
  'sales-pipeline':         'Sales Pipeline',
  'call-analytics':         'Call Analytics',
}

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  'monthly-management':     'Full P&L, KPIs, receivables, stock summary and AI narrative. For monthly management meetings.',
  'executive-summary':      'One-page snapshot with top-line numbers and trend charts. For quick briefings.',
  'distributor-performance':'Ranked distributor revenue with bucket breakdowns and trends. For commercial reviews.',
  'cash-flow':              'Receivables aging, payables aging, cash position. For cash management.',
  'stock-health':           'Reorder alerts, dead stock, velocity analysis. For inventory planning.',
  'sales-pipeline':         'Open quotes, orders, conversion rates by rep. For sales reviews.',
  'call-analytics':         'Phone call coaching scores, rep leaderboard, outcomes and flagged calls. For sales team performance review.',
}

const REPORT_TYPE_ROLES: Record<ReportType, UserRole[]> = {
  'monthly-management':     ['admin', 'manager'],
  'executive-summary':      ['admin', 'manager'],
  'distributor-performance':['admin', 'manager', 'sales'],
  'cash-flow':              ['admin', 'accountant'],
  'stock-health':           ['admin', 'manager'],
  'sales-pipeline':         ['admin', 'manager', 'sales'],
  'call-analytics':         ['admin', 'manager', 'sales'],
}

// Which sidebar tabs each report type implicitly depends on. A user only
// sees a report type in the picker if they have access to ALL required tabs.
// This keeps the report picker honest: if admin hid the Stock tab from a
// user, the Stock Health report shouldn't tempt them either.
//
// Reasoning per report:
// - monthly-management: top-line P&L + receivables + stock → needs all of those tabs
// - executive-summary: KPI summary → needs overview + P&L at minimum
// - distributor-performance: needs Distributors
// - cash-flow: needs Invoices (receivables) + Payables
// - stock-health: needs Stock
// - sales-pipeline: needs Leads/Orders
// - call-analytics: needs Phone Calls
//
// Keep in sync with PORTAL_TABS ids below.
const REPORT_TYPE_REQUIRED_TABS: Record<ReportType, string[]> = {
  'monthly-management':     ['overview', 'invoices', 'pnl', 'stock'],
  'executive-summary':      ['overview', 'pnl'],
  'distributor-performance':['distributors'],
  'cash-flow':              ['invoices', 'payables'],
  'stock-health':           ['stock'],
  'sales-pipeline':         ['leads'],
  'call-analytics':         ['calls'],
}

export function requiredTabsForReportType(type: ReportType): string[] {
  return REPORT_TYPE_REQUIRED_TABS[type] || []
}

export function roleCanGenerateReportType(role: UserRole, type: ReportType): boolean {
  return REPORT_TYPE_ROLES[type]?.includes(role) ?? false
}

export function reportTypesForRole(role: UserRole): ReportType[] {
  return (Object.keys(REPORT_TYPE_ROLES) as ReportType[])
    .filter(t => roleCanGenerateReportType(role, t))
}

// Per-user filter for which report types a specific user can generate.
//
// Filtering order (all must pass):
//   1. Role permits the report type            — always enforced
//   2. If `visibleReports` set, type is in it  — admin explicit override
//   3. If `visibleTabs` set, user has ALL tabs the report needs — auto-hide
//
// If either override is null/undefined/empty, that layer is skipped
// (original behaviour preserved).
export function userCanGenerateReportType(
  role: UserRole,
  type: ReportType,
  visibleReports?: string[] | null,
  visibleTabs?: string[] | null,
): boolean {
  if (!roleCanGenerateReportType(role, type)) return false
  if (visibleReports && visibleReports.length > 0 && !visibleReports.includes(type)) return false
  if (visibleTabs && visibleTabs.length > 0) {
    const required = REPORT_TYPE_REQUIRED_TABS[type] || []
    const tabSet = new Set(visibleTabs)
    for (const tab of required) {
      if (!tabSet.has(tab)) return false
    }
  }
  return true
}

export function reportTypesForUser(
  role: UserRole,
  visibleReports?: string[] | null,
  visibleTabs?: string[] | null,
): ReportType[] {
  return reportTypesForRole(role).filter(t =>
    userCanGenerateReportType(role, t, visibleReports, visibleTabs)
  )
}

// ── Portal tabs catalog ──────────────────────────────────────────────
// Source of truth for sidebar tab metadata — shared between UI (sidebar
// rendering, admin tab-picker) and the permission helpers below. Keep in
// sync with DEFAULT_NAV in lib/PortalSidebar.tsx.

export interface PortalTab {
  id: string                 // nav item ID used in PortalSidebar DEFAULT_NAV
  label: string              // user-facing name
  permission: Permission     // permission required to see this tab
}

export const PORTAL_TABS: PortalTab[] = [
  { id: 'overview',      label: 'Overview',        permission: 'view:overview' },
  { id: 'leads',         label: 'Leads/Orders',    permission: 'view:leads' },
  { id: 'distributors',  label: 'Distributors',    permission: 'view:distributors' },
  { id: 'calls',         label: 'Phone Calls',     permission: 'view:calls' },
  { id: 'reports',       label: 'Reports',         permission: 'view:reports' },
  { id: 'todos',         label: 'To-Dos',          permission: 'view:todos' },
  { id: 'jobs',          label: 'Jobs',            permission: 'view:jobs' },
  { id: 'vehicle-sales', label: 'Vehicle Sales',   permission: 'view:vehicle_sales' },
  { id: 'invoices',      label: 'Invoices',        permission: 'view:invoices' },
  { id: 'pnl',           label: 'P&L',             permission: 'view:pnl' },
  { id: 'stock',         label: 'Stock',           permission: 'view:stock' },
  { id: 'payables',      label: 'Payables',        permission: 'view:payables' },
]

// Tabs available to a role BY DEFAULT (i.e. when no per-user override is set).
// Derived from ROLE_PERMISSIONS so adding a new tab only needs a PORTAL_TABS
// entry + a permission — no duplication.
export function defaultTabsForRole(role: UserRole): string[] {
  return PORTAL_TABS.filter(t => roleHasPermission(role, t.permission)).map(t => t.id)
}

// For client-side UI: which sidebar sections should be visible to this user?
//
// If `visibleTabs` is provided (from user_profiles.visible_tabs), it OVERRIDES
// the role defaults — the user sees exactly those tabs (intersected with the
// tabs they have the underlying permission for, as a safety net).
//
// If `visibleTabs` is null/undefined, the user gets every tab their role has
// permission for (original behaviour).
//
// 'settings' is added automatically for admins regardless of the list — it's
// not a "tab" the admin would ever tick/untick.
export function visibleNavSections(role: UserRole, visibleTabs?: string[] | null): string[] {
  const allowed = new Set(defaultTabsForRole(role))
  let result: string[]
  if (visibleTabs && visibleTabs.length > 0) {
    // Use the per-user list, but keep only tabs the role is actually
    // permitted to see. A user with a custom list can't be granted tabs
    // their role doesn't have the permission for (safety net against
    // stale rows or privilege escalation).
    result = visibleTabs.filter(t => allowed.has(t))
  } else {
    result = Array.from(allowed)
  }
  if (roleHasPermission(role, 'admin:settings')) result.push('settings')
  return result
}

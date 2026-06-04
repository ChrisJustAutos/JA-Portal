// lib/permissions.ts
// Role → permission mapping. Shared between client (for UI gating) and server (for API gating).
// Source of truth — if you add a new feature, add its permission here first.

export type UserRole = 'admin' | 'manager' | 'sales' | 'accountant' | 'viewer' | 'workshop'

export const ROLE_LABELS: Record<UserRole, string> = {
  admin:      'Admin',
  manager:    'Manager',
  sales:      'Sales',
  workshop:   'Workshop',
  accountant: 'Accountant',
  viewer:     'Viewer',
}

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin:      'Full access including user management and settings',
  manager:    'All data, cannot manage users or settings',
  sales:      'Leads/Orders, read-only distributors',
  workshop:   'Workshop only — diary, jobs, quotes, inventory & tasks. No financial, leads or admin access.',
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
  | 'view:stocktakes'
  | 'view:b2b'
  | 'view:stripe_myob'
  | 'view:diary'
  | 'view:messages'
  | 'view:crm'
  | 'manage:inbox'
  // Actions
  | 'edit:any'
  | 'edit:distributors_groups'
  | 'edit:vin_codes'
  | 'edit:leads'
  | 'edit:supplier_invoices'
  | 'edit:stocktakes'
  | 'edit:b2b_catalogue'
  | 'edit:b2b_distributors'
  | 'edit:b2b_orders'
  | 'edit:stripe_myob'
  | 'edit:bookings'
  | 'edit:crm'
  | 'generate:reports'
  | 'monitor:calls'
  // Admin
  | 'admin:users'
  | 'admin:settings'
  | 'admin:audit_log'
  | 'admin:b2b'

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports','view:todos','view:supplier_invoices',
    'view:jobs','view:vehicle_sales','view:stocktakes','view:b2b','view:stripe_myob',
    'edit:any','edit:distributors_groups','edit:vin_codes','edit:leads','edit:supplier_invoices','edit:stocktakes','generate:reports',
    'edit:b2b_catalogue','edit:b2b_distributors','edit:b2b_orders','edit:stripe_myob',
    'monitor:calls',
    'view:diary','edit:bookings',
    'view:messages','manage:inbox',
    'view:crm','edit:crm',
    'admin:users','admin:settings','admin:audit_log','admin:b2b',
  ],
  manager: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports','view:todos','view:supplier_invoices',
    'view:jobs','view:vehicle_sales','view:stocktakes','view:b2b','view:stripe_myob',
    'edit:leads','edit:supplier_invoices','edit:stocktakes','generate:reports',
    'edit:b2b_catalogue','edit:b2b_distributors','edit:b2b_orders',
    'monitor:calls',
    'view:diary','edit:bookings',
    'view:messages','manage:inbox',
    'view:crm','edit:crm',
  ],
  sales: [
    'view:dashboards','view:overview','view:leads','view:distributors','view:calls','view:reports',
    'view:b2b',
    'edit:leads','generate:reports',
    'view:diary','edit:bookings',
    'view:messages','manage:inbox',
    'view:crm','edit:crm',
  ],
  // Least-privilege workshop login: only the workshop area (diary + jobs +
  // quotes + inventory + tasks all gate on view:diary). No financial/leads/
  // calls/admin access. Trim to diary-only per user via the tab allowlist.
  workshop: [
    'view:diary','edit:bookings',
    'view:messages',
  ],
  accountant: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:payables','view:reports',
    'view:supplier_invoices','edit:supplier_invoices',
    'view:distributors',
    'view:jobs','view:vehicle_sales','view:b2b','view:stripe_myob','edit:stripe_myob',
    'generate:reports',
    'view:messages',
  ],
  viewer: [
    'view:dashboards','view:overview','view:invoices','view:pnl','view:stock','view:payables',
    'view:leads','view:distributors','view:calls','view:reports',
    'view:messages',
  ],
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}

// ── Report type access ────────────────────────────────────────────────

export type ReportType =
  | 'distributor-performance'
  | 'stock-health'
  | 'call-analytics'
  | 'crm-pipeline'
  | 'campaign-performance'
  | 'workshop-performance'
  | 'b2b-sales'

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  'distributor-performance':'Distributor Performance Review',
  'stock-health':           'Stock Health',
  'call-analytics':         'Call Analytics',
  'crm-pipeline':           'CRM Pipeline',
  'campaign-performance':   'Campaign Performance',
  'workshop-performance':   'Workshop Performance',
  'b2b-sales':              'B2B Sales',
}

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  'distributor-performance':'Ranked distributor revenue with bucket breakdowns and trends. For commercial reviews.',
  'stock-health':           'Reorder alerts, dead stock, velocity analysis. For inventory planning.',
  'call-analytics':         'Phone call coaching scores, rep leaderboard, outcomes and flagged calls. For sales team performance review.',
  'crm-pipeline':           'Lead pipeline by stage and owner, win/loss and conversion over the period. From the CRM.',
  'campaign-performance':   'Email campaign sends with open, click and unsubscribe rates over the period.',
  'workshop-performance':   'Bookings, completed jobs, revenue and quote conversion from the workshop.',
  'b2b-sales':              'Distributor orders, revenue, freight, top distributors and products over the period.',
}

const REPORT_TYPE_ROLES: Record<ReportType, UserRole[]> = {
  'distributor-performance':['admin', 'manager', 'sales'],
  'stock-health':           ['admin', 'manager'],
  'call-analytics':         ['admin', 'manager', 'sales'],
  'crm-pipeline':           ['admin', 'manager', 'sales'],
  'campaign-performance':   ['admin', 'manager', 'sales'],
  'workshop-performance':   ['admin', 'manager'],
  'b2b-sales':              ['admin', 'manager'],
}

const REPORT_TYPE_REQUIRED_TABS: Record<ReportType, string[]> = {
  'distributor-performance':['distributors'],
  'stock-health':           ['stock'],
  'call-analytics':         ['calls'],
  'crm-pipeline':           ['crm'],
  'campaign-performance':   ['crm'],
  'workshop-performance':   ['diary'],
  'b2b-sales':              ['b2b'],
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

export interface PortalTab {
  id: string
  label: string
  permission: Permission
}

export const PORTAL_TABS: PortalTab[] = [
  { id: 'distributors',  label: 'Distributors',    permission: 'view:distributors' },
  { id: 'calls',         label: 'Phone Calls',     permission: 'view:calls' },
  { id: 'crm',           label: 'CRM',             permission: 'view:crm' },
  { id: 'messages',      label: 'Messages',        permission: 'view:messages' },
  { id: 'diary',         label: 'Workshop Diary',  permission: 'view:diary' },
  { id: 'workshop-customers', label: 'Customers',  permission: 'view:diary' },
  { id: 'workshop-quotes', label: 'Quotes',        permission: 'view:diary' },
  { id: 'workshop-invoices', label: 'Invoices (workshop)', permission: 'view:diary' },
  { id: 'workshop-inventory', label: 'Inventory',  permission: 'view:diary' },
  { id: 'reports',       label: 'Reports',         permission: 'view:reports' },
  { id: 'pnl',           label: 'P&L',             permission: 'view:pnl' },
  { id: 'payables',      label: 'Payables',        permission: 'view:payables' },
  { id: 'ap',            label: 'AP Invoices',     permission: 'view:supplier_invoices' },
  { id: 'b2b',           label: 'B2B Portal',      permission: 'view:b2b' },
]

export function defaultTabsForRole(role: UserRole): string[] {
  return PORTAL_TABS.filter(t => roleHasPermission(role, t.permission)).map(t => t.id)
}

export function visibleNavSections(role: UserRole, visibleTabs?: string[] | null): string[] {
  const allowed = new Set(defaultTabsForRole(role))
  let result: string[]
  if (visibleTabs && visibleTabs.length > 0) {
    result = visibleTabs.filter(t => allowed.has(t))
  } else {
    result = Array.from(allowed)
  }
  if (roleHasPermission(role, 'admin:settings')) result.push('settings')
  return result
}

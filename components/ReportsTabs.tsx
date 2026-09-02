// components/ReportsTabs.tsx
// Sub-tab strip for the Reports module: Sales Report · dashboards · maps.
// The old first tab (/reports - the AI-narrative report builder) was removed
// 2026-09-02 at Chris's request; /reports now redirects to the first real tab.
// Sits directly under the global top bar; each tab is gated by its own
// permission. Mirrors InventoryTabs / the CRM sub-tab strip.

import { useRouter } from 'next/router'
import { UserRole, roleHasPermission, Permission } from '../lib/permissions'
import { T } from '../lib/ui/theme'

const TABS: Array<{ id: string; label: string; href: string; perm: Permission; roles?: UserRole[] }> = [
  { id: 'sales-report', label: 'Sales Report', href: '/reports/sales-report', perm: 'view:reports' },
  { id: 'sales-dashboard', label: 'Sales Dashboard', href: '/reports/sales-dashboard', perm: 'view:reports' },
  { id: 'mgmt-dashboard', label: 'Management Dashboard', href: '/reports/mgmt-dashboard', perm: 'view:reports', roles: ['admin', 'manager'] },
  { id: 'forecast', label: 'Forecast', href: '/reports/forecast', perm: 'view:reports', roles: ['admin', 'manager'] },
  // Holds the Distributor Map too since 2026-09-02, hence 'Maps'. The ID stays
  // 'workshop-map' - it is stored in users' visible_report_tabs allowlists.
  { id: 'workshop-map', label: 'Maps', href: '/reports/map',  perm: 'view:reports' },
  { id: 'jaws-stock-eom', label: 'Stock EOM', href: '/reports/jaws-stock-eom', perm: 'view:stock', roles: ['admin', 'manager'] },
  { id: 'distributors', label: 'Distributors', href: '/distributors', perm: 'view:distributors' },
]

export default function ReportsTabs({ active, role, reportTabs }: { active: 'sales-report' | 'sales-dashboard' | 'mgmt-dashboard' | 'forecast' | 'workshop-map' | 'distributors' | 'jaws-stock-eom'; role: UserRole; reportTabs?: string[] | null }) {
  const router = useRouter()
  const tabs = TABS.filter(t =>
    roleHasPermission(role, t.perm) &&
    (!t.roles || t.roles.includes(role)) &&
    // Per-user Reports allowlist (marketing → workshop-map only). The
    // cross-module 'distributors' tab is governed by its own permission.
    (!reportTabs || reportTabs.length === 0 || t.id === 'distributors' || reportTabs.includes(t.id)))
  if (tabs.length <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
      {tabs.map(t => {
        const on = t.id === active
        return (
          <button key={t.id} onClick={() => router.push(t.href)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            color: on ? T.text : T.text2, fontSize: 13, fontWeight: on ? 600 : 400,
            padding: '12px 14px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
          }}>{t.label}</button>
        )
      })}
    </div>
  )
}

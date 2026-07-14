// components/ReportsTabs.tsx
// Sub-tab strip for the Reports module: Reports · Workshop Map · Distributors.
// Sits directly under the global top bar; each tab is gated by its own
// permission. Mirrors InventoryTabs / the CRM sub-tab strip.

import { useRouter } from 'next/router'
import { UserRole, roleHasPermission, Permission } from '../lib/permissions'
import { T } from '../lib/ui/theme'

const TABS: Array<{ id: string; label: string; href: string; perm: Permission }> = [
  { id: 'reports',      label: 'Reports',      href: '/reports',      perm: 'view:reports' },
  { id: 'sales-report', label: 'Sales Report', href: '/reports/sales-report', perm: 'view:reports' },
  { id: 'workshop-map', label: 'Workshop Map', href: '/reports/map',  perm: 'view:reports' },
  { id: 'distributors', label: 'Distributors', href: '/distributors', perm: 'view:distributors' },
]

export default function ReportsTabs({ active, role }: { active: 'reports' | 'sales-report' | 'workshop-map' | 'distributors'; role: UserRole }) {
  const router = useRouter()
  const tabs = TABS.filter(t => roleHasPermission(role, t.perm))
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

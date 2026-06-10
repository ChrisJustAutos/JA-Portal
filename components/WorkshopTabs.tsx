// components/WorkshopTabs.tsx
// Top-level sub-tab strip for the unified Workshop module:
// Diary · Customers · Quotes · Invoices · Inventory. Sits directly under the
// global top bar (all gated view:diary). Inventory has its own second-level
// strip (InventoryTabs) for Inventory/Purchase Orders/Stocktake/Stock Transfer.

import { useRouter } from 'next/router'
import { Permission, UserRole, roleHasPermission } from '../lib/permissions'

const T = { bg2: '#131519', border: 'rgba(255,255,255,0.07)', text: '#e8eaf0', text2: '#8b90a0', accent: '#4f8ef7' }

const TABS: { id: string; label: string; href: string; perm?: Permission }[] = [
  { id: 'diary', label: 'Diary', href: '/diary' },
  { id: 'customers', label: 'Customers', href: '/workshop/customers' },
  { id: 'vehicles', label: 'Vehicles', href: '/workshop/vehicles' },
  { id: 'quotes', label: 'Quotes', href: '/workshop/quotes' },
  { id: 'invoices', label: 'Invoices', href: '/workshop/invoices' },
  { id: 'inventory', label: 'Inventory', href: '/workshop/inventory' },
  { id: 'reports', label: 'Reports', href: '/workshop/reports', perm: 'view:reports' },
]

export type WorkshopTabId = 'diary' | 'customers' | 'vehicles' | 'quotes' | 'invoices' | 'inventory' | 'reports'

export default function WorkshopTabs({ active, role }: { active: WorkshopTabId; role: UserRole }) {
  const router = useRouter()
  if (!roleHasPermission(role, 'view:diary')) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0, overflowX: 'auto' }}>
      {TABS.filter(t => !t.perm || roleHasPermission(role, t.perm)).map(t => {
        const on = t.id === active
        return (
          <button key={t.id} onClick={() => router.push(t.href)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            color: on ? T.text : T.text2, fontSize: 13, fontWeight: on ? 600 : 400,
            padding: '12px 14px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
          }}>{t.label}</button>
        )
      })}
    </div>
  )
}

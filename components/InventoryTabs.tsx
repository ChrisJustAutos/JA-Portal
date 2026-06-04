// components/InventoryTabs.tsx
// Sub-tab strip that unifies the Inventory module: Inventory · Stocktake ·
// Stock Transfer. Sits directly under the global top bar. Each tab is gated by
// its own permission, so a user only sees the parts they can use. Mirrors the
// CRM sub-tab strip styling.

import { useRouter } from 'next/router'
import { UserRole, roleHasPermission, Permission } from '../lib/permissions'

const T = { bg2: '#131519', border: 'rgba(255,255,255,0.07)', text: '#e8eaf0', text2: '#8b90a0', accent: '#4f8ef7' }

const TABS: Array<{ id: string; label: string; href: string; perm: Permission }> = [
  { id: 'inventory', label: 'Inventory',      href: '/workshop/inventory',      perm: 'view:diary' },
  { id: 'stocktake', label: 'Stocktake',      href: '/stocktake',               perm: 'view:stocktakes' },
  { id: 'transfer',  label: 'Stock Transfer', href: '/admin/b2b/stock-transfer', perm: 'edit:b2b_distributors' },
]

export default function InventoryTabs({ active, role }: { active: 'inventory' | 'stocktake' | 'transfer'; role: UserRole }) {
  const router = useRouter()
  const tabs = TABS.filter(t => roleHasPermission(role, t.perm))
  if (tabs.length <= 1) return null   // nothing to switch between → no strip
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

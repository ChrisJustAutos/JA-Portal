// components/b2b/B2BAdminTabs.tsx
// In-app icon sub-nav for the staff B2B section. Sits at the top of
// each /admin/b2b/* page's content, below the global top bar — like an
// Odoo app's own menu. Icon + label tabs, the active one highlighted.

import { AppIcon } from '../../lib/AppIcons'

const T = {
  bg2: '#131519', bg3: '#1a1d23',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4', blue: '#4f8ef7',
}

export type B2BAdminSection = 'dashboard' | 'catalogue' | 'distributors' | 'orders' | 'settings'

const TABS: Array<{ id: B2BAdminSection; label: string; href: string; icon: string }> = [
  { id: 'dashboard',    label: 'Dashboard',    href: '/admin/b2b',              icon: 'overview' },
  { id: 'catalogue',    label: 'Catalogue',    href: '/admin/b2b/catalogue',    icon: 'catalogue' },
  { id: 'distributors', label: 'Distributors', href: '/admin/b2b/distributors', icon: 'distributors' },
  { id: 'orders',       label: 'Orders',       href: '/admin/b2b/orders',       icon: 'orders' },
  { id: 'settings',     label: 'Settings',     href: '/admin/b2b/settings',     icon: 'settings' },
]

export default function B2BAdminTabs({ active }: { active: B2BAdminSection }) {
  return (
    <div style={{
      display: 'flex', gap: 4, flexWrap: 'wrap',
      marginBottom: 22, paddingBottom: 14,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {TABS.map(tab => {
        const on = tab.id === active
        return (
          <a key={tab.id} href={tab.href}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '8px 13px', borderRadius: 8, textDecoration: 'none',
              fontSize: 13, fontWeight: on ? 600 : 500,
              color: on ? T.text : T.text2,
              background: on ? T.bg3 : 'transparent',
              border: `1px solid ${on ? T.border2 : 'transparent'}`,
            }}>
            <span style={{ display: 'flex', color: on ? T.blue : T.text3 }}><AppIcon name={tab.icon} size={17}/></span>
            {tab.label}
          </a>
        )
      })}
    </div>
  )
}

// components/b2b/B2BAdminTabs.tsx
// In-app icon sub-nav for the staff B2B section. Sits at the top of
// each /admin/b2b/* page's content, below the global top bar — like an
// Odoo app's own menu. Icon + label tabs, the active one highlighted.
//
// Mobile: a single horizontally-scrollable strip (no wrapping into a tall
// multi-row block), tighter padding, hidden scrollbar. CSS media query so it
// stays correct under SSR without a useIsMobile hook.

import { AppIcon } from '../../lib/AppIcons'

const T = {
  bg2: '#131519', bg3: '#1a1d23',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4', blue: '#4f8ef7',
}

export type B2BAdminSection = 'dashboard' | 'catalogue' | 'distributors' | 'orders' | 'stock-transfer' | 'settings'

const TABS: Array<{ id: B2BAdminSection; label: string; href: string; icon: string }> = [
  { id: 'dashboard',      label: 'Dashboard',      href: '/admin/b2b',                icon: 'overview' },
  { id: 'catalogue',      label: 'Catalogue',      href: '/admin/b2b/catalogue',      icon: 'catalogue' },
  { id: 'distributors',   label: 'Distributors',   href: '/admin/b2b/distributors',   icon: 'distributors' },
  { id: 'orders',         label: 'Orders',         href: '/admin/b2b/orders',         icon: 'orders' },
  { id: 'stock-transfer', label: 'Stock Transfer', href: '/admin/b2b/stock-transfer', icon: 'stocktake' },
  { id: 'settings',       label: 'Settings',       href: '/admin/b2b/settings',       icon: 'settings' },
]

export default function B2BAdminTabs({ active }: { active: B2BAdminSection }) {
  return (
    <nav className="b2b-admin-tabs" style={{
      display: 'flex', gap: 4, flexWrap: 'nowrap', overflowX: 'auto',
      marginBottom: 22, paddingBottom: 14,
      borderBottom: `1px solid ${T.border}`,
      // full-bleed scroll on mobile so the strip can run edge-to-edge
      WebkitOverflowScrolling: 'touch',
    }}>
      {/* This component renders on every /admin/b2b page, so it's a convenient
          single home for the section's shared mobile CSS. Pages opt in by adding
          className="b2b-admin-main" to their <main> and "b2b-col2" to any fixed
          two-column grid that should stack on a phone. (The order pages tune
          their own mobile layout, so they deliberately don't use these.) */}
      <style>{`
        .b2b-admin-tabs{ scrollbar-width:none; -ms-overflow-style:none; }
        .b2b-admin-tabs::-webkit-scrollbar{ display:none; }
        @media (max-width: 640px){
          .b2b-admin-tabs{ gap:4px; margin-bottom:14px; padding-bottom:10px; }
          .b2b-admin-tabs a{ padding:7px 11px !important; font-size:12.5px !important; }
          .b2b-admin-main{ padding:16px 14px !important; }
          .b2b-admin-main table{ display:block; overflow-x:auto; -webkit-overflow-scrolling:touch; max-width:100%; }
          .b2b-col2{ grid-template-columns:1fr !important; }
        }
      `}</style>
      {TABS.map(tab => {
        const on = tab.id === active
        return (
          <a key={tab.id} href={tab.href}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '8px 13px', borderRadius: 8, textDecoration: 'none',
              fontSize: 13, fontWeight: on ? 600 : 500, whiteSpace: 'nowrap', flexShrink: 0,
              color: on ? T.text : T.text2,
              background: on ? T.bg3 : 'transparent',
              border: `1px solid ${on ? T.border2 : 'transparent'}`,
            }}>
            <span style={{ display: 'flex', color: on ? T.blue : T.text3 }}><AppIcon name={tab.icon} size={17}/></span>
            {tab.label}
          </a>
        )
      })}
    </nav>
  )
}

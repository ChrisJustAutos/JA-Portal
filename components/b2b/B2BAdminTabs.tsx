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

export type B2BAdminSection = 'dashboard' | 'catalogue' | 'distributors' | 'orders' | 'settings'

const TABS: Array<{ id: B2BAdminSection; label: string; href: string; icon: string }> = [
  { id: 'dashboard',      label: 'Dashboard',      href: '/admin/b2b',                icon: 'overview' },
  { id: 'catalogue',      label: 'Catalogue',      href: '/admin/b2b/catalogue',      icon: 'catalogue' },
  { id: 'distributors',   label: 'Distributors',   href: '/admin/b2b/distributors',   icon: 'distributors' },
  { id: 'orders',         label: 'Orders',         href: '/admin/b2b/orders',         icon: 'orders' },
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

          /* Responsive tables → stacked cards. Add class "b2b-cards" to a
             <table> and a data-label to each <td>; on mobile each row becomes a
             labelled card instead of a sideways-scrolling row. Helpers:
             td.b2b-card-title = full-width bold header (no label),
             td.b2b-card-hide = hidden on mobile. */
          table.b2b-cards{ display:block !important; overflow:visible !important; border-collapse:collapse; }
          table.b2b-cards thead{ display:none; }
          table.b2b-cards tbody{ display:block; }
          table.b2b-cards tr{ display:block; border:1px solid ${T.border}; border-radius:10px; background:${T.bg2}; margin-bottom:10px; padding:10px 12px; }
          table.b2b-cards td{ display:flex !important; align-items:center; justify-content:space-between; gap:12px; width:auto !important; padding:5px 0 !important; border:none !important; text-align:right !important; }
          table.b2b-cards td::before{ content:attr(data-label); color:${T.text3}; font-size:11px; font-weight:500; text-align:left; flex-shrink:0; white-space:nowrap; }
          table.b2b-cards td:not([data-label])::before, table.b2b-cards td[data-label=""]::before{ content:none; }
          table.b2b-cards td.b2b-card-title{ display:block !important; text-align:left !important; font-weight:600; font-size:14px; color:${T.text}; padding:0 0 8px !important; margin-bottom:4px; border-bottom:1px solid ${T.border} !important; }
          table.b2b-cards td.b2b-card-title::before{ content:none; }
          table.b2b-cards td.b2b-card-hide{ display:none !important; }
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

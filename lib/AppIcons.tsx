// lib/AppIcons.tsx
// Inline SVG icon set for the app launcher + top bar. lucide-style
// (24×24 viewBox, stroke currentColor, no fill) so they inherit the
// accent colour from the tile and need no external dependency.
//
// Keyed by the nav-item id used in DEFAULT_NAV (lib/PortalSidebar.tsx)
// so the launcher, top bar and sidebar all stay in lockstep.

import React from 'react'

type IconProps = { size?: number; strokeWidth?: number; style?: React.CSSProperties }

function svg(children: React.ReactNode, { size = 24, strokeWidth = 1.9, style }: IconProps) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      style={style} aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// Each entry returns the inner paths for one icon.
const ICONS: Record<string, (p: IconProps) => JSX.Element> = {
  overview: (p) => svg(<>
    <rect x="3" y="3" width="7" height="9" rx="1"/>
    <rect x="14" y="3" width="7" height="5" rx="1"/>
    <rect x="14" y="12" width="7" height="9" rx="1"/>
    <rect x="3" y="16" width="7" height="5" rx="1"/>
  </>, p),
  leads: (p) => svg(<>
    <circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>
    <path d="M2 3h2.2l2.1 12.4a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.2L21 7H5.2"/>
  </>, p),
  distributors: (p) => svg(<>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="3.5"/>
    <path d="M22 21v-2a4 4 0 0 0-3-3.85"/><path d="M16 3.5a4 4 0 0 1 0 7"/>
  </>, p),
  calls: (p) => svg(
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>
  , p),
  diary: (p) => svg(<>
    <rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>
    <circle cx="12" cy="15.5" r="3"/><path d="M12 14.2V15.5l1 .9"/>
  </>, p),
  reports: (p) => svg(<>
    <path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6" rx="0.5"/>
    <rect x="12.5" y="7" width="3" height="10" rx="0.5"/><rect x="18" y="13" width="3" height="4" rx="0.5"/>
  </>, p),
  todos: (p) => svg(<>
    <rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 9h18"/>
    <path d="m9 14 2 2 4-4"/>
  </>, p),
  jobs: (p) => svg(
    <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L3 18l3 3 6.5-6.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.5-.7-.7-2.5 2.4-2.6Z"/>
  , p),
  'vehicle-sales': (p) => svg(<>
    <path d="M5 11l1.5-4.3A2 2 0 0 1 8.4 5.3h7.2a2 2 0 0 1 1.9 1.4L19 11"/>
    <path d="M3 11h18v5a1 1 0 0 1-1 1h-1.5"/><path d="M5.5 17H4a1 1 0 0 1-1-1v-5"/>
    <circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>
  </>, p),
  stocktake: (p) => svg(<>
    <rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 3h6v3H9z"/>
    <path d="M8 11h.01M11 11h5M8 15h.01M11 15h5"/>
  </>, p),
  ap: (p) => svg(<>
    <path d="M5 3v18l2-1.3L9 21l2-1.3L13 21l2-1.3L17 21l2-1.3V3l-2 1.3L15 3l-2 1.3L11 3 9 4.3 7 3Z"/>
    <path d="M9 8h6M9 12h6M9 16h3"/>
  </>, p),
  'stripe-myob': (p) => svg(<>
    <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>
    <path d="M6 15h3"/>
  </>, p),
  b2b: (p) => svg(<>
    <path d="M3 9 4.2 4.5A1.5 1.5 0 0 1 5.6 3.4h12.8a1.5 1.5 0 0 1 1.4 1.1L21 9"/>
    <path d="M3 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 4 0 2.5 2.5 0 0 0 4 0 2.5 2.5 0 0 0 5 0"/>
    <path d="M4 11v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8"/>
  </>, p),
  settings: (p) => svg(<>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 0 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 0 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>
  </>, p),
  // Dashboard sections
  invoices: (p) => svg(<>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/>
    <path d="M14 3v5h5M9 13h6M9 17h6"/>
  </>, p),
  pnl: (p) => svg(<>
    <path d="M3 3v18h18"/><path d="m7 14 3-4 3 3 5-7"/><path d="M18 6h3v3"/>
  </>, p),
  stock: (p) => svg(<>
    <path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>
  </>, p),
  payables: (p) => svg(<>
    <rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>
    <path d="M6 12h.01M18 12h.01"/>
  </>, p),
  // Distributor portal + admin B2B sub-nav
  catalogue: (p) => svg(<>
    <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/>
    <path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>
  </>, p),
  cart: (p) => svg(<>
    <circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>
    <path d="M2 3h2.2l2.1 12.4a1.5 1.5 0 0 0 1.5 1.2h8.9a1.5 1.5 0 0 0 1.5-1.2L21 7H5.2"/>
  </>, p),
  orders: (p) => svg(<>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
    <path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>
  </>, p),
  team: (p) => svg(<>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="3.5"/>
    <path d="M22 21v-2a4 4 0 0 0-3-3.85"/><path d="M16 3.5a4 4 0 0 1 0 7"/>
  </>, p),
  // Order-status glyphs
  pending: (p) => svg(<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, p),
  truck: (p) => svg(<>
    <path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z"/>
    <circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>
  </>, p),
  'check-circle': (p) => svg(<><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/></>, p),
  'x-circle': (p) => svg(<><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></>, p),
  refund: (p) => svg(<>
    <path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 2.6-6.4L3 9"/>
  </>, p),
  all: (p) => svg(<>
    <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </>, p),
}

// Fallback: a generic grid square so an unmapped id never crashes.
function fallbackIcon(p: IconProps) {
  return svg(<rect x="3" y="3" width="18" height="18" rx="3"/>, p)
}

export function AppIcon({ name, size = 24, strokeWidth = 1.9, style }: { name: string } & IconProps) {
  const fn = ICONS[name] || fallbackIcon
  return fn({ size, strokeWidth, style })
}

export function hasAppIcon(name: string): boolean {
  return name in ICONS
}

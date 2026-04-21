// lib/PortalSidebar.tsx
// Shared sidebar component used by index, sales, distributors, reports, settings pages.
// Handles nav rendering, drag-reorder, sort dropdown, and refresh/signout footer.
//
// Updated: now accepts `currentUserRole` and filters visible nav items via
// lib/permissions.visibleNavSections(). Also includes a Settings nav item
// visible only to admins. Sign-out calls the new /api/auth/session DELETE.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from './supabaseClient'
import { UserRole, visibleNavSections } from './permissions'
import { usePreferences } from './preferences'

// ── Design tokens (kept in sync with portal) ─────────────────
const T = {
  bg2: '#131519', bg3: '#1a1d23',
  border: 'rgba(255,255,255,0.07)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
  accent: '#4f8ef7',
}

export type PortalSection = 'overview'|'invoices'|'pnl'|'stock'|'payables'
export type NavSort = 'default'|'az'|'za'|'custom'

export interface PortalNavItem {
  id: string
  kind: 'link' | 'section'
  label: string
  href?: string              // for link type — e.g. '/sales'
  section?: PortalSection    // for section type — internal portal tab
  dot: string                // colour of the indicator dot
  alertKey?: 'invoices'|'payables'
}

// Default nav order — same on every page. `settings` is appended for admins only (see rendering).
export const DEFAULT_NAV: PortalNavItem[] = [
  {id:'overview',     kind:'link',    label:'Overview',     href:'/overview',      dot:T.blue},
  {id:'leads',        kind:'link',    label:'Leads/Orders', href:'/sales',         dot:'#a78bfa'},
  {id:'distributors', kind:'link',    label:'Distributors', href:'/distributors',  dot:T.blue},
  {id:'reports',      kind:'link',    label:'Reports',      href:'/reports',       dot:T.green},
  {id:'todos',        kind:'link',    label:'To-Dos',       href:'/todos',         dot:T.amber},
  {id:'jobs',         kind:'link',    label:'Jobs',         href:'/jobs',          dot:T.teal},
  {id:'vehicle-sales',kind:'link',    label:'Vehicle Sales',href:'/vehicle-sales', dot:'#34c77b'},
  {id:'invoices',     kind:'section', label:'Invoices',          section:'invoices', dot:T.amber, alertKey:'invoices'},
  {id:'pnl',          kind:'section', label:'P&L — This Month',  section:'pnl',      dot:T.green},
  {id:'stock',        kind:'section', label:'Stock & Inventory', section:'stock',    dot:T.purple},
  {id:'payables',     kind:'section', label:'Payables',          section:'payables', dot:T.red,   alertKey:'payables'},
]

// Settings nav item (admins only) — added after filtering
const SETTINGS_NAV_ITEM: PortalNavItem = {
  id:'settings', kind:'link', label:'⚙ Settings', href:'/settings', dot:T.text3,
}

export interface PortalSidebarProps {
  activeId: string
  onSectionClick?: (section: PortalSection) => void
  lastRefresh?: Date | null
  onRefresh?: () => void
  refreshing?: boolean
  alertCounts?: { invoices?: number; payables?: number }
  loading?: boolean

  // Role of the currently signed-in user. When provided, nav items are filtered
  // to only those the role has permission to view. When omitted (e.g. during
  // SSR fallback) all items are shown — server-side route guards are the actual
  // source of truth, this is just UX polish.
  currentUserRole?: UserRole
  // Per-user tab override. When provided (non-null), only these tab IDs show
  // in the sidebar (intersected with role permissions). When null/undefined,
  // the user sees every tab their role has permission for.
  currentUserVisibleTabs?: string[] | null
  currentUserName?: string | null
  currentUserEmail?: string | null
}

export default function PortalSidebar({
  activeId,
  onSectionClick,
  lastRefresh,
  onRefresh,
  refreshing,
  alertCounts = {},
  loading = false,
  currentUserRole,
  currentUserVisibleTabs,
  currentUserName,
  currentUserEmail,
}: PortalSidebarProps) {
  const router = useRouter()
  const { prefs } = usePreferences()
  const [navSort, setNavSort] = useState<NavSort>('default')
  const [customOrder, setCustomOrder] = useState<string[]>([])
  const [draggedId, setDraggedId] = useState<string|null>(null)
  const [dragOverId, setDragOverId] = useState<string|null>(null)

  // Mobile-awareness: on narrow viewports (< 768px) render as a slide-over
  // drawer with a hamburger toggle. Desktop keeps the classic fixed sidebar.
  const [isMobile, setIsMobile] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  // Close drawer when user navigates to a different page
  useEffect(() => {
    const close = () => setDrawerOpen(false)
    router.events.on('routeChangeStart', close)
    return () => router.events.off('routeChangeStart', close)
  }, [router])

  // Build the base nav, filtering by role (and per-user tab list) if provided
  const baseNav: PortalNavItem[] = (() => {
    if (!currentUserRole) return [...DEFAULT_NAV]
    const allowed = new Set(visibleNavSections(currentUserRole, currentUserVisibleTabs))
    const filtered = DEFAULT_NAV.filter(it => allowed.has(it.id))
    if (allowed.has('settings')) filtered.push(SETTINGS_NAV_ITEM)
    return filtered
  })()

  // Compute sorted order
  const sortedItems: PortalNavItem[] = (() => {
    if (navSort === 'az') return [...baseNav].sort((a,b) => a.label.localeCompare(b.label))
    if (navSort === 'za') return [...baseNav].sort((a,b) => b.label.localeCompare(a.label))
    if (navSort === 'custom' && customOrder.length === baseNav.length) {
      const byId: Record<string, PortalNavItem> = {}
      baseNav.forEach(it => { byId[it.id] = it })
      return customOrder.map(id => byId[id]).filter(Boolean)
    }
    return baseNav
  })()

  function handleClick(item: PortalNavItem) {
    if (item.kind === 'link') {
      router.push(item.href!)
      return
    }
    if (onSectionClick) onSectionClick(item.section!)
    else router.push(`/dashboard?s=${item.section}`)
  }

  // Drag handlers
  function handleDragStart(e: React.DragEvent, id: string) {
    if (navSort !== 'custom') return
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }
  function handleDragOver(e: React.DragEvent, id: string) {
    if (navSort !== 'custom' || !draggedId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (id !== dragOverId) setDragOverId(id)
  }
  function handleDrop(e: React.DragEvent, targetId: string) {
    if (navSort !== 'custom' || !draggedId) return
    e.preventDefault()
    if (draggedId === targetId) { setDraggedId(null); setDragOverId(null); return }
    const order = sortedItems.map(it => it.id)
    const fromIdx = order.indexOf(draggedId)
    const toIdx = order.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) { setDraggedId(null); setDragOverId(null); return }
    const [moved] = order.splice(fromIdx, 1)
    order.splice(toIdx, 0, moved)
    setCustomOrder(order)
    setDraggedId(null); setDragOverId(null)
  }
  function handleDragEnd() { setDraggedId(null); setDragOverId(null) }

  function handleSortChange(v: NavSort) {
    if (v === 'custom') setCustomOrder(sortedItems.map(it => it.id))
    setNavSort(v)
  }

  async function handleSignOut() {
    try {
      // Clear Supabase SDK session (client-side)
      try { await getSupabase().auth.signOut() } catch {}
      // Clear our httpOnly session cookie
      await fetch('/api/auth/session', { method: 'DELETE' }).catch(()=>{})
    } finally {
      router.push('/login')
    }
  }

  const dragEnabled = navSort === 'custom'

  // The sidebar body (nav + footer) — shared by mobile drawer and desktop panel
  const sidebarBody = (
    <div style={{
      width: isMobile ? 280 : 220, minWidth: isMobile ? 280 : 220,
      background: T.bg2, borderRight: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto',
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
      {/* Logo block */}
      <div style={{padding:'20px 18px 16px', borderBottom:`1px solid ${T.border}`}}>
        <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:4}}>
          <div style={{width:30, height:30, borderRadius:8, background:T.blue, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:600, color:'#fff', flexShrink:0}}>JA</div>
          <div style={{fontSize:14, fontWeight:600, color:T.text}}>Just Autos</div>
          {prefs.company_logo_url && (
            <div style={{
              marginLeft:'auto',
              width:28, height:28,
              background:'#fff',
              borderRadius:4,
              display:'flex', alignItems:'center', justifyContent:'center',
              overflow:'hidden',
              flexShrink:0,
            }}>
              <img
                src={prefs.company_logo_url}
                alt="Company logo"
                style={{maxWidth:'100%', maxHeight:'100%', objectFit:'contain'}}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            </div>
          )}
        </div>
        <div style={{fontSize:11, color:T.text3, marginLeft:40}}>Management Portal</div>
      </div>

      {/* Nav list */}
      <div style={{padding:'14px 10px 4px', flex:1}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 8px', marginBottom:6}}>
          <div style={{fontSize:9, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.1em'}}>Navigation</div>
          <select value={navSort} onChange={e => handleSortChange(e.target.value as NavSort)}
            style={{background:'transparent', border:`1px solid ${T.border}`, color:T.text3, borderRadius:4, padding:'2px 5px', fontSize:9, fontFamily:'inherit', cursor:'pointer', outline:'none'}}>
            <option value="default">Default</option>
            <option value="az">A–Z</option>
            <option value="za">Z–A</option>
            <option value="custom">Custom (drag)</option>
          </select>
        </div>

        {sortedItems.map(it => {
          const isActive = activeId === it.id
          const isDragging = draggedId === it.id
          const isDragOver = dragOverId === it.id && draggedId !== it.id
          const alertCount = it.alertKey ? (alertCounts[it.alertKey] || 0) : 0

          const bg = isActive ? 'rgba(255,255,255,0.04)' : 'transparent'
          const color = isActive ? T.text : T.text2

          return (
            <div
              key={it.id}
              draggable={dragEnabled}
              onDragStart={(e) => handleDragStart(e, it.id)}
              onDragOver={(e) => handleDragOver(e, it.id)}
              onDrop={(e) => handleDrop(e, it.id)}
              onDragEnd={handleDragEnd}
              onClick={() => handleClick(it)}
              style={{
                display:'flex', alignItems:'center', gap:9,
                padding:'8px 10px', borderRadius:7,
                cursor: dragEnabled ? 'grab' : 'pointer',
                fontSize:13, marginBottom:1,
                background: bg, color: color,
                opacity: isDragging ? 0.4 : 1,
                outline: isDragOver ? `2px dashed ${T.accent}` : 'none',
                outlineOffset: -2,
                transition: 'opacity 0.15s, outline 0.1s, background 0.1s',
                userSelect: 'none',
              }}>
              {dragEnabled && <span style={{fontSize:10, color:T.text3, cursor:'grab', marginRight:-4}}>⋮⋮</span>}
              <div style={{width:7, height:7, borderRadius:'50%', background:it.dot, flexShrink:0}}/>
              <span style={{flex:1}}>{it.label}</span>
              {it.alertKey && !loading && alertCount > 0 && (
                <span style={{fontSize:10, fontFamily:'monospace', background:'rgba(240,78,78,0.2)', color:T.red, padding:'2px 6px', borderRadius:4}}>
                  {alertCount}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{padding:'12px 14px', borderTop:`1px solid ${T.border}`}}>
        {/* User identity — shown when we know who's signed in */}
        {(currentUserName || currentUserEmail) && (
          <div style={{marginBottom:10, paddingBottom:10, borderBottom:`1px solid ${T.border}`}}>
            <div style={{fontSize:12, color:T.text, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
              {currentUserName || currentUserEmail}
            </div>
            {currentUserRole && (
              <div style={{fontSize:10, color:T.text3, textTransform:'capitalize', marginTop:2}}>{currentUserRole}</div>
            )}
          </div>
        )}

        {onRefresh && (
          <>
            <div style={{fontSize:10, color:T.text3, marginBottom:5}}>
              {lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString('en-AU', {hour:'2-digit', minute:'2-digit'})}` : 'Loading…'}
            </div>
            <button onClick={onRefresh} disabled={refreshing}
              style={{fontSize:12, color:T.blue, background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', padding:0, display:'block', marginBottom:4}}>
              {refreshing ? 'Refreshing…' : '↻ Refresh data'}
            </button>
          </>
        )}
        <button onClick={handleSignOut}
          style={{fontSize:12, color:T.text3, background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', padding:0}}>
          Sign out →
        </button>
      </div>
    </div>
  )

  // ─── Mobile drawer layout ───
  // Hamburger button is fixed top-left so it's always reachable, even after
  // scrolling. Drawer slides in from the left with a dimmed overlay behind it.
  // Also emits a thin inline spacer so the page header doesn't render under
  // the hamburger button (since hamburger is position:fixed it contributes
  // no inline width).
  if (isMobile) {
    return (
      <>
        {/* Inline spacer — part of the parent flex flow so page content shifts right */}
        <div style={{width: 50, flexShrink: 0, height: '100vh'}} aria-hidden="true"/>
        <button
          aria-label="Open navigation menu"
          onClick={() => setDrawerOpen(true)}
          style={{
            position: 'fixed', top: 10, left: 10, zIndex: 1001,
            width: 40, height: 40, borderRadius: 8,
            background: T.bg3, border: `1px solid ${T.border}`, color: T.text,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 18, padding: 0,
          }}
        >☰</button>
        {drawerOpen && (
          <>
            <div
              onClick={() => setDrawerOpen(false)}
              style={{
                position: 'fixed', inset: 0, zIndex: 1002,
                background: 'rgba(0,0,0,0.55)',
              }}
            />
            <div style={{
              position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 1003,
              boxShadow: '2px 0 24px rgba(0,0,0,0.4)',
            }}>
              {sidebarBody}
            </div>
          </>
        )}
      </>
    )
  }

  // ─── Desktop layout ───
  return sidebarBody
}

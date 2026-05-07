// lib/PortalSidebar.tsx
// Shared sidebar component used by index, sales, distributors, calls, reports, settings pages.
// Handles nav rendering, sort dropdown, user-defined groups (drag-and-drop in edit
// mode, persisted via /api/preferences -> user_preferences.nav_groups), and the
// refresh/signout footer.

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from './supabaseClient'
import { UserRole, visibleNavSections } from './permissions'
import { usePreferences, NavGroup } from './preferences'

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
export type NavSort = 'default'|'az'|'za'

// Per-group drag state. Tracks what's being dragged and where it's hovering
// so we can render drop indicators and resolve drops to the right container.
type DragKind = 'item' | 'group'
interface DragState {
  kind: DragKind
  id: string
  // For item drags: source container — group id or null (ungrouped)
  fromGroupId: string | null
}

function genGroupId(): string {
  return 'grp_' + Math.random().toString(36).slice(2, 10)
}

export interface PortalNavItem {
  id: string
  kind: 'link' | 'section'
  label: string
  href?: string
  section?: PortalSection
  dot: string
  alertKey?: 'invoices'|'payables'
}

// Default nav order — same on every page. `settings` is appended for admins only (see rendering).
export const DEFAULT_NAV: PortalNavItem[] = [
  {id:'overview',     kind:'link',    label:'Overview',     href:'/overview',      dot:T.blue},
  {id:'leads',        kind:'link',    label:'Leads/Orders', href:'/sales',         dot:'#a78bfa'},
  {id:'distributors', kind:'link',    label:'Distributors', href:'/distributors',  dot:T.blue},
  {id:'calls',        kind:'link',    label:'Phone Calls',  href:'/calls',         dot:T.teal},
  {id:'reports',      kind:'link',    label:'Reports',      href:'/reports',       dot:T.green},
  {id:'todos',        kind:'link',    label:'To-Dos',       href:'/todos',         dot:T.amber},
  {id:'jobs',         kind:'link',    label:'Jobs',         href:'/jobs',          dot:T.teal},
  {id:'vehicle-sales',kind:'link',    label:'Vehicle Sales',href:'/vehicle-sales', dot:'#34c77b'},
  {id:'stocktake',    kind:'link',    label:'Stocktake',    href:'/stocktake',     dot:T.purple},
  {id:'ap',           kind:'link',    label:'AP Invoices',  href:'/ap',            dot:T.amber},
  {id:'b2b',          kind:'link',    label:'B2B Portal',   href:'/admin/b2b',     dot:T.teal},
  {id:'invoices',     kind:'section', label:'Invoices',          section:'invoices', dot:T.amber, alertKey:'invoices'},
  {id:'pnl',          kind:'section', label:'P&L — This Month',  section:'pnl',      dot:T.green},
  {id:'stock',        kind:'section', label:'Stock & Inventory', section:'stock',    dot:T.purple},
  {id:'payables',     kind:'section', label:'Payables',          section:'payables', dot:T.red,   alertKey:'payables'},
]

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
  currentUserRole?: UserRole
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
  const { prefs, update } = usePreferences()
  const [navSort, setNavSort] = useState<NavSort>('default')
  const [editing, setEditing] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null)
  const [dragOverContainerId, setDragOverContainerId] = useState<string | null>(null) // group id or '__ungrouped__'
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)

  const [isMobile, setIsMobile] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  useEffect(() => {
    const close = () => setDrawerOpen(false)
    router.events.on('routeChangeStart', close)
    return () => router.events.off('routeChangeStart', close)
  }, [router])

  const baseNav: PortalNavItem[] = useMemo(() => {
    if (!currentUserRole) return [...DEFAULT_NAV]
    const allowed = new Set(visibleNavSections(currentUserRole, currentUserVisibleTabs))
    const filtered = DEFAULT_NAV.filter(it => allowed.has(it.id))
    if (allowed.has('settings')) filtered.push(SETTINGS_NAV_ITEM)
    return filtered
  }, [currentUserRole, currentUserVisibleTabs])

  const navById: Record<string, PortalNavItem> = useMemo(() => {
    const m: Record<string, PortalNavItem> = {}
    baseNav.forEach(it => { m[it.id] = it })
    return m
  }, [baseNav])

  // Resolve persisted groups against the current allowed nav list. Drops
  // unknown ids silently (a removed feature or a permission change) without
  // mutating stored prefs — they'll be cleaned up next time the user saves.
  const resolvedGroups = useMemo(() => {
    return (prefs.nav_groups || []).map(g => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      items: g.item_ids.map(id => navById[id]).filter(Boolean) as PortalNavItem[],
    }))
  }, [prefs.nav_groups, navById])

  const groupedItemIds = useMemo(() => {
    const s = new Set<string>()
    for (const g of prefs.nav_groups || []) for (const id of g.item_ids) s.add(id)
    return s
  }, [prefs.nav_groups])

  const ungroupedItems: PortalNavItem[] = useMemo(() => {
    const items = baseNav.filter(it => !groupedItemIds.has(it.id))
    if (navSort === 'az') return [...items].sort((a, b) => a.label.localeCompare(b.label))
    if (navSort === 'za') return [...items].sort((a, b) => b.label.localeCompare(a.label))
    return items
  }, [baseNav, groupedItemIds, navSort])

  function handleClick(item: PortalNavItem) {
    if (editing) return  // clicks select for rename / no-op while editing
    if (item.kind === 'link') {
      router.push(item.href!)
      return
    }
    if (onSectionClick) onSectionClick(item.section!)
    else router.push(`/dashboard?s=${item.section}`)
  }

  // ── Group mutations (autosave on every change) ──────────────────────────
  async function saveGroups(next: NavGroup[]) {
    try { await update({ nav_groups: next }) } catch { /* preferences hook surfaces errors */ }
  }
  function addGroup() {
    const id = genGroupId()
    const next: NavGroup[] = [...(prefs.nav_groups || []), { id, name: 'New group', collapsed: false, item_ids: [] }]
    saveGroups(next)
    setRenamingGroupId(id)
  }
  function renameGroup(id: string, name: string) {
    const trimmed = name.trim().slice(0, 80) || 'Untitled'
    const next = (prefs.nav_groups || []).map(g => g.id === id ? { ...g, name: trimmed } : g)
    saveGroups(next)
  }
  function deleteGroup(id: string) {
    const next = (prefs.nav_groups || []).filter(g => g.id !== id)
    saveGroups(next)
  }
  function toggleCollapsed(id: string) {
    const next = (prefs.nav_groups || []).map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g)
    saveGroups(next)
  }
  function reorderGroups(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    const order = (prefs.nav_groups || []).map(g => g.id)
    const from = order.indexOf(draggedId)
    const to = order.indexOf(targetId)
    if (from < 0 || to < 0) return
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    const byId: Record<string, NavGroup> = {}
    for (const g of prefs.nav_groups || []) byId[g.id] = g
    saveGroups(order.map(id => byId[id]))
  }
  // Move item to (or within) a target. targetGroupId=null means ungrouped.
  // beforeItemId=null means append to the end.
  function moveItem(itemId: string, targetGroupId: string | null, beforeItemId: string | null) {
    let next = (prefs.nav_groups || []).map(g => ({ ...g, item_ids: g.item_ids.filter(id => id !== itemId) }))
    if (targetGroupId) {
      next = next.map(g => {
        if (g.id !== targetGroupId) return g
        const arr = [...g.item_ids]
        const insertAt = beforeItemId ? arr.indexOf(beforeItemId) : -1
        if (insertAt >= 0) arr.splice(insertAt, 0, itemId)
        else arr.push(itemId)
        return { ...g, item_ids: arr }
      })
    }
    saveGroups(next)
  }

  // ── DnD handlers ────────────────────────────────────────────────────────
  function onDragStartItem(e: React.DragEvent, itemId: string, fromGroupId: string | null) {
    if (!editing) return
    setDrag({ kind: 'item', id: itemId, fromGroupId })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', itemId)
  }
  function onDragStartGroup(e: React.DragEvent, groupId: string) {
    if (!editing) return
    setDrag({ kind: 'group', id: groupId, fromGroupId: null })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', groupId)
  }
  function onDragOverItem(e: React.DragEvent, itemId: string, containerId: string) {
    if (!drag || drag.kind !== 'item') return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverItemId !== itemId) setDragOverItemId(itemId)
    if (dragOverContainerId !== containerId) setDragOverContainerId(containerId)
  }
  function onDragOverContainer(e: React.DragEvent, containerId: string) {
    if (!drag || drag.kind !== 'item') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverContainerId !== containerId) setDragOverContainerId(containerId)
    if (dragOverItemId !== null) setDragOverItemId(null)
  }
  function onDragOverGroupHeader(e: React.DragEvent, groupId: string) {
    if (!drag) return
    if (drag.kind === 'group') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOverContainerId !== `__group_header__${groupId}`) setDragOverContainerId(`__group_header__${groupId}`)
    } else if (drag.kind === 'item') {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dragOverContainerId !== groupId) setDragOverContainerId(groupId)
      if (dragOverItemId !== null) setDragOverItemId(null)
    }
  }
  function onDropItem(e: React.DragEvent, beforeItemId: string, containerId: string) {
    if (!drag || drag.kind !== 'item') return
    e.preventDefault(); e.stopPropagation()
    const targetGroupId = containerId === '__ungrouped__' ? null : containerId
    if (drag.id !== beforeItemId) moveItem(drag.id, targetGroupId, beforeItemId)
    resetDrag()
  }
  function onDropContainer(e: React.DragEvent, containerId: string) {
    if (!drag || drag.kind !== 'item') return
    e.preventDefault()
    const targetGroupId = containerId === '__ungrouped__' ? null : containerId
    moveItem(drag.id, targetGroupId, null)
    resetDrag()
  }
  function onDropGroupHeader(e: React.DragEvent, groupId: string) {
    if (!drag) return
    e.preventDefault()
    if (drag.kind === 'group') {
      reorderGroups(drag.id, groupId)
    } else if (drag.kind === 'item') {
      moveItem(drag.id, groupId, null)
    }
    resetDrag()
  }
  function resetDrag() { setDrag(null); setDragOverItemId(null); setDragOverContainerId(null) }

  function handleSortChange(v: NavSort) { setNavSort(v) }

  async function handleSignOut() {
    try {
      try { await getSupabase().auth.signOut() } catch {}
      await fetch('/api/auth/session', { method: 'DELETE' }).catch(()=>{})
    } finally {
      router.push('/login')
    }
  }

  // Renders a single nav item. containerId = group id or null (ungrouped).
  function renderNavItem(it: PortalNavItem, containerId: string | null) {
    const isActive = activeId === it.id
    const isDragging = drag?.kind === 'item' && drag.id === it.id
    const isDropTarget = drag?.kind === 'item' && dragOverItemId === it.id && drag.id !== it.id
    const alertCount = it.alertKey ? (alertCounts[it.alertKey] || 0) : 0
    const bg = isActive ? 'rgba(255,255,255,0.04)' : 'transparent'
    const color = isActive ? T.text : T.text2
    const containerKey = containerId ?? '__ungrouped__'

    return (
      <div
        key={it.id}
        draggable={editing}
        onDragStart={(e) => onDragStartItem(e, it.id, containerId)}
        onDragOver={(e) => onDragOverItem(e, it.id, containerKey)}
        onDrop={(e) => onDropItem(e, it.id, containerKey)}
        onDragEnd={resetDrag}
        onClick={() => handleClick(it)}
        style={{
          display:'flex', alignItems:'center', gap:9,
          padding:'8px 10px', borderRadius:7,
          cursor: editing ? 'grab' : 'pointer',
          fontSize:13, marginBottom:1,
          background: bg, color: color,
          opacity: isDragging ? 0.4 : 1,
          borderTop: isDropTarget ? `2px solid ${T.accent}` : '2px solid transparent',
          transition: 'opacity 0.15s, background 0.1s',
          userSelect: 'none',
        }}>
        {editing && <span style={{fontSize:10, color:T.text3, marginRight:-4}}>⋮⋮</span>}
        <div style={{width:7, height:7, borderRadius:'50%', background:it.dot, flexShrink:0}}/>
        <span style={{flex:1}}>{it.label}</span>
        {it.alertKey && !loading && alertCount > 0 && (
          <span style={{fontSize:10, fontFamily:'monospace', background:'rgba(240,78,78,0.2)', color:T.red, padding:'2px 6px', borderRadius:4}}>
            {alertCount}
          </span>
        )}
      </div>
    )
  }

  const sidebarBody = (
    <div style={{
      width: isMobile ? 280 : 220, minWidth: isMobile ? 280 : 220,
      background: T.bg2, borderRight: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto',
      fontFamily: "'DM Sans', system-ui, sans-serif",
    }}>
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

      <div style={{padding:'14px 10px 4px', flex:1}}>
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 8px', marginBottom:6, gap:6}}>
          <div style={{fontSize:9, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.1em'}}>Navigation</div>
          <div style={{display:'flex', alignItems:'center', gap:4}}>
            <select value={navSort} onChange={e => handleSortChange(e.target.value as NavSort)}
              style={{background:'transparent', border:`1px solid ${T.border}`, color:T.text3, borderRadius:4, padding:'2px 5px', fontSize:9, fontFamily:'inherit', cursor:'pointer', outline:'none'}}>
              <option value="default">Default</option>
              <option value="az">A–Z</option>
              <option value="za">Z–A</option>
            </select>
            <button onClick={() => setEditing(e => !e)} title={editing ? 'Done editing' : 'Edit groups'}
              style={{
                background: editing ? T.accent : 'transparent', border:`1px solid ${editing ? T.accent : T.border}`,
                color: editing ? '#fff' : T.text3, borderRadius:4, padding:'2px 6px',
                fontSize:9, fontFamily:'inherit', cursor:'pointer', outline:'none',
              }}>
              {editing ? 'Done' : '✎ Edit'}
            </button>
          </div>
        </div>

        {editing && (
          <button onClick={addGroup}
            style={{
              width:'calc(100% - 4px)', margin:'0 2px 6px', padding:'6px 8px',
              background:'transparent', border:`1px dashed ${T.border}`, color:T.text2,
              borderRadius:6, fontSize:11, fontFamily:'inherit', cursor:'pointer', outline:'none',
            }}>
            + New group
          </button>
        )}

        {/* Groups (top) */}
        {resolvedGroups.map(g => {
          const isGroupDragOver = dragOverContainerId === `__group_header__${g.id}` && drag?.kind === 'group' && drag.id !== g.id
          const isItemDropOver = dragOverContainerId === g.id && drag?.kind === 'item' && dragOverItemId === null
          return (
            <div key={g.id} style={{marginBottom:4}}>
              <div
                draggable={editing}
                onDragStart={(e) => onDragStartGroup(e, g.id)}
                onDragOver={(e) => onDragOverGroupHeader(e, g.id)}
                onDrop={(e) => onDropGroupHeader(e, g.id)}
                onDragEnd={resetDrag}
                onClick={() => !editing && toggleCollapsed(g.id)}
                style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'5px 8px', borderRadius:6,
                  cursor: editing ? 'grab' : 'pointer',
                  fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.08em',
                  color: T.text3,
                  background: isItemDropOver ? 'rgba(79,142,247,0.10)' : 'transparent',
                  outline: isGroupDragOver ? `2px dashed ${T.accent}` : 'none',
                  outlineOffset: -2,
                  userSelect:'none',
                }}>
                {editing && <span style={{fontSize:10, color:T.text3}}>⋮⋮</span>}
                <span style={{
                  display:'inline-block', width:8, transform: g.collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                  transition:'transform 0.12s', color:T.text3, fontSize:8,
                }}>▶</span>
                {editing && renamingGroupId === g.id ? (
                  <input
                    autoFocus
                    defaultValue={g.name}
                    onBlur={(e) => { renameGroup(g.id, e.target.value); setRenamingGroupId(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenamingGroupId(null) }}
                    style={{
                      flex:1, background:T.bg3, border:`1px solid ${T.border}`, color:T.text,
                      borderRadius:3, padding:'1px 5px', fontSize:10, fontFamily:'inherit',
                      textTransform:'uppercase', letterSpacing:'0.08em', outline:'none',
                    }}
                  />
                ) : (
                  <span
                    onClick={(e) => { if (editing) { e.stopPropagation(); setRenamingGroupId(g.id) } }}
                    style={{flex:1}}
                  >{g.name}</span>
                )}
                {!editing && <span style={{fontSize:9, color:T.text3, fontFamily:'monospace'}}>{g.items.length}</span>}
                {editing && (
                  <button
                    onClick={(e) => { e.stopPropagation(); if (g.items.length === 0 || confirm(`Delete group "${g.name}"? Items will return to ungrouped.`)) deleteGroup(g.id) }}
                    title="Delete group"
                    style={{background:'transparent', border:'none', color:T.text3, fontSize:12, cursor:'pointer', padding:'0 2px', lineHeight:1}}
                  >×</button>
                )}
              </div>

              {!g.collapsed && (
                <div
                  onDragOver={(e) => onDragOverContainer(e, g.id)}
                  onDrop={(e) => onDropContainer(e, g.id)}
                  style={{minHeight: editing && g.items.length === 0 ? 22 : undefined, paddingLeft: 8}}
                >
                  {editing && g.items.length === 0 && (
                    <div style={{fontSize:10, color:T.text3, padding:'3px 8px', fontStyle:'italic'}}>Drop items here</div>
                  )}
                  {g.items.map(it => renderNavItem(it, g.id))}
                </div>
              )}
            </div>
          )
        })}

        {/* Ungrouped (bottom) */}
        {(ungroupedItems.length > 0 || (editing && resolvedGroups.length > 0)) && (
          <div style={{marginTop: resolvedGroups.length > 0 ? 8 : 0}}>
            {resolvedGroups.length > 0 && (
              <div style={{
                fontSize:10, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.08em',
                padding:'5px 8px',
              }}>Ungrouped</div>
            )}
            <div
              onDragOver={(e) => onDragOverContainer(e, '__ungrouped__')}
              onDrop={(e) => onDropContainer(e, '__ungrouped__')}
            >
              {ungroupedItems.map(it => renderNavItem(it, null))}
            </div>
          </div>
        )}
      </div>

      <div style={{padding:'12px 14px', borderTop:`1px solid ${T.border}`}}>
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

  if (isMobile) {
    return (
      <>
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

  return sidebarBody
}

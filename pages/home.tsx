// pages/home.tsx
// Odoo-style app launcher — the portal's landing page. A grid of app
// tiles, role-filtered, with search-as-you-type plus iPhone-style
// gestures:
//   - drag a tile onto the CENTRE of another → make/expand a folder
//   - drag a tile onto the LEFT/RIGHT EDGE of another → reorder
//   - "Edit names" mode → rename tiles inline
// All of it persists per-user via user_preferences (nav_groups for
// folders, app_labels for renames, launcher_order for arrangement).

import { useMemo, useState, useCallback, useEffect } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../lib/authServer'
import type { UserRole } from '../lib/permissions'
import { useVisibleApps, LauncherApp } from '../lib/PortalTopBar'
import { AppIcon } from '../lib/AppIcons'
import { usePreferences, NavGroup } from '../lib/preferences'
import { getSupabase } from '../lib/supabaseClient'
import { useNotificationSummary } from '../lib/useNotifications'
import NotificationBell from '../components/NotificationBell'
import { T } from '../lib/ui/theme'

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, null)
}

interface Props {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

function genGroupId(): string { return 'grp_' + Math.random().toString(36).slice(2, 10) }

type ResolvedFolder = { id: string; name: string; apps: LauncherApp[] }
type Cell =
  | { kind: 'folder'; id: string; folder: ResolvedFolder }
  | { kind: 'app'; id: string; app: LauncherApp }

type DropMode = 'before' | 'after' | 'merge'
type Drag = { id: string; kind: 'app' | 'folder' } | null

export default function HomePage({ user }: Props) {
  const router = useRouter()
  const apps = useVisibleApps(user.role, user.visibleTabs)
  // Per-module unread badges (notifications + chat messages), 30s poll.
  const { summary, refresh: refreshSummary } = useNotificationSummary()
  const badgeFor = useCallback((appId: string): number => {
    if (appId === 'messages') return summary?.messages || 0
    return summary?.byModule?.[appId] || 0
  }, [summary])
  const { prefs, update, loading: prefsLoading } = usePreferences()
  const [query, setQuery] = useState('')
  const [drag, setDrag] = useState<Drag>(null)
  const [dragOver, setDragOver] = useState<{ id: string; mode: DropMode } | null>(null)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [editMode, setEditMode] = useState(false)

  const appById = useMemo(() => {
    const m: Record<string, LauncherApp> = {}
    for (const a of apps) m[a.id] = a
    return m
  }, [apps])

  const folders: ResolvedFolder[] = useMemo(() => {
    return (prefs.nav_groups || []).map(g => ({
      id: g.id,
      name: g.name,
      apps: g.item_ids.map(id => appById[id]).filter(Boolean) as LauncherApp[],
    })).filter(f => f.apps.length > 0)
  }, [prefs.nav_groups, appById])

  const groupedIds = useMemo(() => {
    const s = new Set<string>()
    for (const f of folders) for (const a of f.apps) s.add(a.id)
    return s
  }, [folders])

  const ungrouped = useMemo(() => apps.filter(a => !groupedIds.has(a.id)), [apps, groupedIds])

  // Unified, ordered list of grid cells. Default order is folders first,
  // then apps; launcher_order (per-user) overrides it. Unlisted cells
  // keep their default relative position, appended after listed ones.
  const orderedCells: Cell[] = useMemo(() => {
    const base: Cell[] = [
      ...folders.map(f => ({ kind: 'folder' as const, id: f.id, folder: f })),
      ...ungrouped.map(a => ({ kind: 'app' as const, id: a.id, app: a })),
    ]
    const order = prefs.launcher_order || []
    const idx = new Map(order.map((id, i) => [id, i]))
    return base
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const ai = idx.has(a.c.id) ? (idx.get(a.c.id) as number) : Infinity
        const bi = idx.has(b.c.id) ? (idx.get(b.c.id) as number) : Infinity
        return ai !== bi ? ai - bi : a.i - b.i
      })
      .map(x => x.c)
  }, [folders, ungrouped, prefs.launcher_order])

  const openFolder = folders.find(f => f.id === openFolderId) || null

  // Safety net: always clear drag state when any drag ends, even if the
  // dragged tile unmounted mid-merge (its own onDragEnd wouldn't fire).
  useEffect(() => {
    const clear = () => { setDrag(null); setDragOver(null) }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear) }
  }, [])

  // ── Persistence helpers ───────────────────────────────────────────
  const saveGroups = useCallback((next: NavGroup[]) => { update({ nav_groups: next }).catch(() => {}) }, [update])
  const saveOrder = useCallback((next: string[]) => { update({ launcher_order: next }).catch(() => {}) }, [update])

  function createFolder(targetAppId: string, draggedAppId: string) {
    if (targetAppId === draggedAppId) return
    const gid = genGroupId()
    const g: NavGroup = { id: gid, name: 'Folder', collapsed: false, item_ids: [targetAppId, draggedAppId] }
    const groups = [g, ...(prefs.nav_groups || []).map(x => ({ ...x, item_ids: x.item_ids.filter(id => id !== targetAppId && id !== draggedAppId) }))].filter(x => x.item_ids.length > 0)
    // Drop the two merged app ids out of the order and slot the new
    // folder where the target tile was, so it appears in place.
    const ids = orderedCells.map(c => c.id)
    const tpos = ids.indexOf(targetAppId)
    const nextOrder = ids.filter(id => id !== targetAppId && id !== draggedAppId)
    nextOrder.splice(tpos < 0 ? nextOrder.length : Math.min(tpos, nextOrder.length), 0, gid)
    update({ nav_groups: groups, launcher_order: nextOrder }).catch(() => {})
  }
  function addToFolder(folderId: string, appId: string) {
    const next = (prefs.nav_groups || []).map(g => {
      if (g.id === folderId) return { ...g, item_ids: Array.from(new Set([...g.item_ids, appId])) }
      return { ...g, item_ids: g.item_ids.filter(id => id !== appId) }
    })
    saveGroups(next.filter(g => g.item_ids.length > 0))
  }
  function removeFromFolder(folderId: string, appId: string) {
    let next = (prefs.nav_groups || []).map(g => g.id === folderId ? { ...g, item_ids: g.item_ids.filter(id => id !== appId) } : g)
    next = next.filter(g => g.item_ids.length >= 2)   // dissolve singletons (iOS-style)
    saveGroups(next)
    if (!next.find(g => g.id === folderId)) setOpenFolderId(null)
  }
  function renameFolder(folderId: string, name: string) {
    const trimmed = name.trim().slice(0, 40) || 'Folder'
    saveGroups((prefs.nav_groups || []).map(g => g.id === folderId ? { ...g, name: trimmed } : g))
  }
  function reorder(draggedId: string, targetId: string, mode: 'before' | 'after') {
    if (draggedId === targetId) return
    const ids = orderedCells.map(c => c.id)
    const from = ids.indexOf(draggedId); if (from < 0) return
    ids.splice(from, 1)
    let to = ids.indexOf(targetId); if (to < 0) return
    if (mode === 'after') to += 1
    ids.splice(to, 0, draggedId)
    saveOrder(ids)
  }
  function saveLabel(appId: string, name: string, defaultLabel: string) {
    const next = { ...(prefs.app_labels || {}) }
    const trimmed = name.trim().slice(0, 40)
    if (!trimmed || trimmed === defaultLabel) delete next[appId]
    else next[appId] = trimmed
    update({ app_labels: next }).catch(() => {})
  }

  // Which third of a tile is the cursor over → reorder vs merge.
  function modeFor(e: React.DragEvent, targetKind: 'app' | 'folder'): DropMode {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const w = rect.width || 1
    // A dragged folder can't be merged into anything — reorder only.
    if (drag?.kind === 'folder') return x < w / 2 ? 'before' : 'after'
    if (x < w * 0.30) return 'before'
    if (x > w * 0.70) return 'after'
    return 'merge'
  }

  function handleCellDragOver(e: React.DragEvent, cell: Cell) {
    if (!drag || drag.id === cell.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const mode = modeFor(e, cell.kind)
    setDragOver(prev => (prev && prev.id === cell.id && prev.mode === mode) ? prev : { id: cell.id, mode })
  }
  function handleCellDrop(e: React.DragEvent, cell: Cell) {
    e.preventDefault()
    const d = drag
    const ov = dragOver
    setDrag(null); setDragOver(null)
    if (!d || d.id === cell.id) return
    const mode = ov && ov.id === cell.id ? ov.mode : modeFor(e, cell.kind)
    if (mode === 'merge') {
      if (cell.kind === 'folder') { if (d.kind === 'app') addToFolder(cell.id, d.id) }
      else if (d.kind === 'app') createFolder(cell.id, d.id)
      else reorder(d.id, cell.id, 'before')
    } else {
      reorder(d.id, cell.id, mode)
    }
  }

  // ── Search (flat, folder-agnostic) ────────────────────────────────
  const searching = query.trim().length > 0
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    return apps.filter(a => a.label.toLowerCase().includes(q))
  }, [apps, query])

  function launch(app: LauncherApp) { router.push(app.href) }

  async function handleSignOut() {
    try {
      try { await getSupabase().auth.signOut() } catch {}
      await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => {})
    } finally {
      router.push('/login')
    }
  }

  const greetingName = (user.displayName || user.email || '').split('@')[0].split(' ')[0]
  const dropModeFor = (cellId: string): DropMode | undefined => (dragOver && dragOver.id === cellId && !!drag && drag.id !== cellId) ? dragOver.mode : undefined

  return (
    <>
      <Head><title>Just Autos — Portal</title></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif" }}>
        <header style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: `1px solid ${T.border}`, background: T.bg2 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#fff' }}>JA</div>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Just Autos</span>
          <span style={{ flex: 1 }}/>
          <NotificationBell apps={apps} summary={summary} refresh={refreshSummary}/>
          <span style={{ fontSize: 12.5, color: T.text2 }}>{user.displayName || user.email}</span>
          <button onClick={handleSignOut}
            style={{ background: 'transparent', border: `1px solid ${T.border}`, color: T.text2, borderRadius: 8, padding: '6px 11px', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}>
            Sign out →
          </button>
        </header>

        <main style={{ maxWidth: 980, margin: '0 auto', padding: '48px 24px 60px' }}>
          <h1 style={{ fontSize: 26, fontWeight: 600, margin: '0 0 4px' }}>
            {greetingName ? `Welcome back, ${greetingName}` : 'Welcome back'}
          </h1>
          <div style={{ fontSize: 14, color: T.text3, marginBottom: 26 }}>
            Drag a tile onto another to make a folder, or onto its left/right edge to reorder.
          </div>

          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search apps…"
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 16, background: T.bg2, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 10, padding: '12px 16px', fontSize: 15, fontFamily: 'inherit', outline: 'none' }}
          />

          {!searching && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <button
                onClick={() => setEditMode(e => !e)}
                style={{ background: editMode ? T.accent : 'transparent', border: `1px solid ${editMode ? T.accent : T.border2}`, color: editMode ? '#fff' : T.text2, borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}>
                {editMode ? 'Done' : '✎ Edit names'}
              </button>
              {editMode && <span style={{ fontSize: 11.5, color: T.text3 }}>Type a new name on any tile. Drag is paused while editing.</span>}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 14 }}>
            {prefsLoading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <div key={`sk${i}`} aria-hidden style={{ height: 118, borderRadius: 14, background: T.bg2, border: `1px solid ${T.border}`, opacity: 0.45 }}/>
                ))
              : searching
              ? searchResults.map(app => (<AppTile key={app.id} app={app} badge={badgeFor(app.id)} onClick={() => launch(app)}/>))
              : orderedCells.map(cell => cell.kind === 'folder' ? (
                  <FolderTile
                    key={cell.id}
                    name={cell.folder.name}
                    apps={cell.folder.apps}
                    badge={cell.folder.apps.reduce((s, a) => s + badgeFor(a.id), 0)}
                    draggable={!editMode}
                    dropMode={dropModeFor(cell.id)}
                    onOpen={() => { if (!drag) setOpenFolderId(cell.id) }}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', cell.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id: cell.id, kind: 'folder' }) }}
                    onDragEnd={() => { setDrag(null); setDragOver(null) }}
                    onDragOver={(e) => handleCellDragOver(e, cell)}
                    onDrop={(e) => handleCellDrop(e, cell)}
                  />
                ) : (
                  <AppTile
                    key={cell.id}
                    app={cell.app}
                    badge={badgeFor(cell.app.id)}
                    draggable={!editMode}
                    editMode={editMode}
                    onCommitRename={(name) => saveLabel(cell.app.id, name, cell.app.defaultLabel)}
                    isDragging={drag?.id === cell.id}
                    dropMode={dropModeFor(cell.id)}
                    onClick={() => { if (!drag) launch(cell.app) }}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', cell.id); e.dataTransfer.effectAllowed = 'move'; setDrag({ id: cell.id, kind: 'app' }) }}
                    onDragEnd={() => { setDrag(null); setDragOver(null) }}
                    onDragOver={(e) => handleCellDragOver(e, cell)}
                    onDrop={(e) => handleCellDrop(e, cell)}
                  />
                ))}
          </div>
          {searching && searchResults.length === 0 && (
            <div style={{ color: T.text3, fontSize: 13, textAlign: 'center', padding: 28 }}>No apps match “{query}”.</div>
          )}
        </main>
      </div>

      {/* Folder overlay */}
      {openFolder && (
        <div
          onClick={() => { setOpenFolderId(null); setRenaming(false) }}
          style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(8,10,13,0.8)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '80px 24px', overflowY: 'auto' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 640, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 16, padding: 24, boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
              {renaming ? (
                <input
                  autoFocus
                  defaultValue={openFolder.name}
                  onBlur={(e) => { renameFolder(openFolder.id, e.target.value); setRenaming(false) }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }}
                  style={{ flex: 1, background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '8px 12px', fontSize: 18, fontWeight: 600, fontFamily: 'inherit', outline: 'none' }}
                />
              ) : (
                <h2 onClick={() => setRenaming(true)} title="Click to rename" style={{ margin: 0, fontSize: 19, fontWeight: 600, cursor: 'text' }}>{openFolder.name}</h2>
              )}
              <span style={{ flex: 1 }}/>
              <button onClick={() => { setOpenFolderId(null); setRenaming(false) }} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 14 }}>
              {openFolder.apps.map(app => (
                <div key={app.id} style={{ position: 'relative' }}>
                  <AppTile app={app} badge={badgeFor(app.id)} onClick={() => launch(app)}/>
                  <button
                    onClick={() => removeFromFolder(openFolder.id, app.id)}
                    title="Remove from folder"
                    style={{ position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: 10, border: 'none', background: T.bg4, color: T.text2, fontSize: 13, lineHeight: 1, cursor: 'pointer' }}
                  >×</button>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: T.text3, marginTop: 16 }}>Removing the second-to-last app dissolves the folder.</div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Insertion bar shown on a tile edge during a reorder drag ──────────
function InsertBar({ side }: { side: 'left' | 'right' }) {
  return <div style={{ position: 'absolute', top: 4, bottom: 4, [side]: -9, width: 3, borderRadius: 2, background: T.accent, boxShadow: `0 0 6px ${T.accent}` }}/>
}

// ── Tiles ────────────────────────────────────────────────────────────
function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span style={{
      position: 'absolute', top: 8, right: 8,
      minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
      background: '#f04e4e', color: '#fff', fontSize: 10, fontWeight: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'monospace', pointerEvents: 'none',
    }}>{count > 99 ? '99+' : count}</span>
  )
}

function AppTile({
  app, badge = 0, onClick, draggable, isDragging, dropMode, editMode, onCommitRename,
  onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  app: LauncherApp
  badge?: number
  onClick: () => void
  draggable?: boolean
  isDragging?: boolean
  dropMode?: DropMode
  editMode?: boolean
  onCommitRename?: (name: string) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const isCustom = app.label !== app.defaultLabel
  const merging = dropMode === 'merge'
  return (
    <div
      draggable={draggable}
      onClick={editMode ? undefined : onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '22px 12px',
        background: T.bg2,
        border: `1px solid ${merging ? app.accent : T.border}`,
        borderRadius: 14, cursor: editMode ? 'default' : 'pointer',
        opacity: isDragging ? 0.4 : 1,
        boxShadow: merging ? `0 0 0 2px ${app.accent}55` : 'none',
        transition: 'transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => { if (!dropMode && !editMode) e.currentTarget.style.transform = 'translateY(-3px)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {dropMode === 'before' && <InsertBar side="left"/>}
      {dropMode === 'after' && <InsertBar side="right"/>}
      <Badge count={badge}/>
      <div style={{ width: 60, height: 60, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${app.accent}1f`, color: app.accent, border: `1px solid ${app.accent}33`, pointerEvents: 'none' }}>
        <AppIcon name={app.id} size={34}/>
      </div>
      {editMode ? (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <input
            defaultValue={app.label}
            placeholder={app.defaultLabel}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            onBlur={e => onCommitRename?.(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '4px 6px', fontSize: 12, fontFamily: 'inherit', textAlign: 'center', outline: 'none' }}
          />
          {isCustom && (
            <button
              onClick={e => { e.stopPropagation(); onCommitRename?.('') }}
              title={`Reset to “${app.defaultLabel}”`}
              style={{ background: 'none', border: 'none', color: T.text3, fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
              ↺ reset
            </button>
          )}
        </div>
      ) : (
        <span style={{ fontSize: 12.5, fontWeight: 500, color: T.text, textAlign: 'center', lineHeight: 1.25, pointerEvents: 'none' }}>{app.label}</span>
      )}
    </div>
  )
}

function FolderTile({
  name, apps, badge = 0, draggable, dropMode, onOpen, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  name: string
  apps: LauncherApp[]
  badge?: number
  draggable?: boolean
  dropMode?: DropMode
  onOpen: () => void
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const preview = apps.slice(0, 4)
  const merging = dropMode === 'merge'
  return (
    <div
      draggable={draggable}
      onClick={onOpen}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '22px 12px',
        background: T.bg2,
        border: `1px solid ${merging ? T.accent : T.border}`,
        borderRadius: 14, cursor: 'pointer',
        boxShadow: merging ? `0 0 0 2px ${T.accent}55` : 'none',
        transition: 'transform 0.12s ease, border-color 0.12s ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => { if (!dropMode) e.currentTarget.style.transform = 'translateY(-3px)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {dropMode === 'before' && <InsertBar side="left"/>}
      {dropMode === 'after' && <InsertBar side="right"/>}
      <Badge count={badge}/>
      {/* iOS-style mini 2x2 preview */}
      <div style={{ width: 60, height: 60, borderRadius: 14, background: T.bg4, border: `1px solid ${T.border2}`, padding: 7, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 4, pointerEvents: 'none' }}>
        {preview.map(a => (
          <div key={a.id} style={{ borderRadius: 5, background: `${a.accent}22`, color: a.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AppIcon name={a.id} size={13}/>
          </div>
        ))}
        {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
          <div key={`e${i}`} style={{ borderRadius: 5, background: 'rgba(255,255,255,0.03)' }}/>
        ))}
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: T.text, textAlign: 'center', lineHeight: 1.25, pointerEvents: 'none' }}>
        {name} <span style={{ color: T.text3 }}>({apps.length})</span>
      </span>
    </div>
  )
}

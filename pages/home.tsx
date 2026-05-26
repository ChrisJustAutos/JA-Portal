// pages/home.tsx
// Odoo-style app launcher — the portal's landing page. A grid of app
// tiles, role-filtered, with search-as-you-type AND iPhone-style
// folders: drag one app tile onto another to create a folder, drag a
// tile onto a folder to add it. Folders persist per-user by reusing
// the existing user_preferences.nav_groups store.

import { useMemo, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../lib/authServer'
import type { UserRole } from '../lib/permissions'
import { useVisibleApps, LauncherApp } from '../lib/PortalTopBar'
import { AppIcon } from '../lib/AppIcons'
import { usePreferences, NavGroup } from '../lib/preferences'
import { getSupabase } from '../lib/supabaseClient'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', accent: '#4f8ef7',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, null)
}

interface Props {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

function genGroupId(): string { return 'grp_' + Math.random().toString(36).slice(2, 10) }

// What's currently being dragged.
type Drag = { appId: string } | null

export default function HomePage({ user }: Props) {
  const router = useRouter()
  const apps = useVisibleApps(user.role, user.visibleTabs)
  const { prefs, update } = usePreferences()
  const [query, setQuery] = useState('')
  const [drag, setDrag] = useState<Drag>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)

  const appById = useMemo(() => {
    const m: Record<string, LauncherApp> = {}
    for (const a of apps) m[a.id] = a
    return m
  }, [apps])

  // Resolve folders against the visible app set; drop unknown ids.
  const folders = useMemo(() => {
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

  const openFolder = folders.find(f => f.id === openFolderId) || null

  // ── Persistence helpers ───────────────────────────────────────────
  const saveGroups = useCallback((next: NavGroup[]) => {
    update({ nav_groups: next }).catch(() => {})
  }, [update])

  function createFolder(targetAppId: string, draggedAppId: string) {
    if (targetAppId === draggedAppId) return
    const g: NavGroup = { id: genGroupId(), name: 'Folder', collapsed: false, item_ids: [targetAppId, draggedAppId] }
    // Strip the dragged/target ids out of any existing folder first.
    const cleaned = (prefs.nav_groups || []).map(x => ({ ...x, item_ids: x.item_ids.filter(id => id !== targetAppId && id !== draggedAppId) }))
    saveGroups([g, ...cleaned].filter(x => x.item_ids.length > 0))
  }
  function addToFolder(folderId: string, appId: string) {
    const next = (prefs.nav_groups || []).map(g => {
      if (g.id === folderId) return { ...g, item_ids: Array.from(new Set([...g.item_ids, appId])) }
      // Remove from any other folder so an app lives in exactly one.
      return { ...g, item_ids: g.item_ids.filter(id => id !== appId) }
    })
    saveGroups(next.filter(g => g.item_ids.length > 0))
  }
  function removeFromFolder(folderId: string, appId: string) {
    let next = (prefs.nav_groups || []).map(g => g.id === folderId ? { ...g, item_ids: g.item_ids.filter(id => id !== appId) } : g)
    // iOS behaviour: a folder with a single app left dissolves.
    next = next.filter(g => g.item_ids.length >= 2)
    saveGroups(next)
    const stillThere = next.find(g => g.id === folderId)
    if (!stillThere) setOpenFolderId(null)
  }
  function renameFolder(folderId: string, name: string) {
    const trimmed = name.trim().slice(0, 40) || 'Folder'
    saveGroups((prefs.nav_groups || []).map(g => g.id === folderId ? { ...g, name: trimmed } : g))
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

  return (
    <>
      <Head><title>Just Autos — Portal</title></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif" }}>
        <header style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', borderBottom: `1px solid ${T.border}`, background: T.bg2 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#fff' }}>JA</div>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Just Autos</span>
          <span style={{ fontSize: 12, color: T.text3 }}>Management Portal</span>
          <span style={{ flex: 1 }}/>
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
            Pick an app to get started. Drag one tile onto another to make a folder.
          </div>

          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search apps…"
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 24, background: T.bg2, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 10, padding: '12px 16px', fontSize: 15, fontFamily: 'inherit', outline: 'none' }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 14 }}>
            {searching
              ? searchResults.map(app => (
                  <AppTile key={app.id} app={app} onClick={() => launch(app)}/>
                ))
              : (
                <>
                  {folders.map(f => (
                    <FolderTile
                      key={f.id}
                      name={f.name}
                      apps={f.apps}
                      isDropTarget={dragOverId === f.id}
                      onOpen={() => setOpenFolderId(f.id)}
                      onDragOver={(e) => { if (drag) { e.preventDefault(); setDragOverId(f.id) } }}
                      onDragLeave={() => setDragOverId(prev => prev === f.id ? null : prev)}
                      onDrop={(e) => { e.preventDefault(); if (drag) addToFolder(f.id, drag.appId); setDrag(null); setDragOverId(null) }}
                    />
                  ))}
                  {ungrouped.map(app => (
                    <AppTile
                      key={app.id}
                      app={app}
                      draggable
                      isDragging={drag?.appId === app.id}
                      isDropTarget={dragOverId === app.id && drag?.appId !== app.id}
                      onClick={() => launch(app)}
                      onDragStart={() => setDrag({ appId: app.id })}
                      onDragEnd={() => { setDrag(null); setDragOverId(null) }}
                      onDragOver={(e) => { if (drag && drag.appId !== app.id) { e.preventDefault(); setDragOverId(app.id) } }}
                      onDragLeave={() => setDragOverId(prev => prev === app.id ? null : prev)}
                      onDrop={(e) => { e.preventDefault(); if (drag && drag.appId !== app.id) createFolder(app.id, drag.appId); setDrag(null); setDragOverId(null) }}
                    />
                  ))}
                </>
              )}
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
                  <AppTile app={app} onClick={() => launch(app)}/>
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

// ── Tiles ────────────────────────────────────────────────────────────
function AppTile({
  app, onClick, draggable, isDragging, isDropTarget,
  onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop,
}: {
  app: LauncherApp
  onClick: () => void
  draggable?: boolean
  isDragging?: boolean
  isDropTarget?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: React.DragEvent) => void
}) {
  return (
    <div
      draggable={draggable}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '22px 12px',
        background: T.bg2,
        border: `1px solid ${isDropTarget ? app.accent : T.border}`,
        borderRadius: 14, cursor: 'pointer',
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDropTarget ? `0 0 0 2px ${app.accent}55` : 'none',
        transition: 'transform 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => { if (!isDropTarget) e.currentTarget.style.transform = 'translateY(-3px)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)' }}
    >
      <div style={{ width: 60, height: 60, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${app.accent}1f`, color: app.accent, border: `1px solid ${app.accent}33` }}>
        <AppIcon name={app.id} size={34}/>
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: T.text, textAlign: 'center', lineHeight: 1.25 }}>{app.label}</span>
    </div>
  )
}

function FolderTile({
  name, apps, isDropTarget, onOpen, onDragOver, onDragLeave, onDrop,
}: {
  name: string
  apps: LauncherApp[]
  isDropTarget?: boolean
  onOpen: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const preview = apps.slice(0, 4)
  return (
    <div
      onClick={onOpen}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        padding: '22px 12px',
        background: T.bg2,
        border: `1px solid ${isDropTarget ? T.accent : T.border}`,
        borderRadius: 14, cursor: 'pointer',
        boxShadow: isDropTarget ? `0 0 0 2px ${T.accent}55` : 'none',
        transition: 'transform 0.12s ease, border-color 0.12s ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {/* iOS-style mini 2x2 preview */}
      <div style={{ width: 60, height: 60, borderRadius: 14, background: T.bg4, border: `1px solid ${T.border2}`, padding: 7, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 4 }}>
        {preview.map(a => (
          <div key={a.id} style={{ borderRadius: 5, background: `${a.accent}22`, color: a.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <AppIcon name={a.id} size={13}/>
          </div>
        ))}
        {Array.from({ length: Math.max(0, 4 - preview.length) }).map((_, i) => (
          <div key={`e${i}`} style={{ borderRadius: 5, background: 'rgba(255,255,255,0.03)' }}/>
        ))}
      </div>
      <span style={{ fontSize: 12.5, fontWeight: 500, color: T.text, textAlign: 'center', lineHeight: 1.25 }}>
        {name} <span style={{ color: T.text3 }}>({apps.length})</span>
      </span>
    </div>
  )
}

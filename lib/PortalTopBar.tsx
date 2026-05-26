// lib/PortalTopBar.tsx
// Top-bar navigation chrome that replaces the old left sidebar. Renders
// a fixed bar (logo → home, current app title, Apps launcher, user menu)
// and a full-screen Apps launcher overlay (grid of icon tiles).
//
// Drop-in for PortalSidebar: same prop names so converting a page is a
// component swap + setting the page container to flex-direction: column.
//
// The launcher grid is shared with pages/home.tsx via the exported
// <AppGrid/> + useVisibleApps() so the landing page and the in-app
// overlay never drift.

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from './supabaseClient'
import { UserRole, visibleNavSections } from './permissions'
import { DEFAULT_NAV, PortalNavItem } from './PortalSidebar'
import { AppIcon } from './AppIcons'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}

const SETTINGS_APP: PortalNavItem = {
  id: 'settings', kind: 'link', label: 'Settings', href: '/settings', dot: T.text3,
}

export const TOPBAR_HEIGHT = 56

export interface LauncherApp {
  id: string
  label: string
  href: string
  accent: string
  alertKey?: 'invoices' | 'payables'
}

// Resolve the apps this user can see, in DEFAULT_NAV order, mapped to
// launcher tiles. Section-kind items (invoices/pnl/stock/payables) route
// through /dashboard like the sidebar did.
export function useVisibleApps(role?: UserRole, visibleTabs?: string[] | null): LauncherApp[] {
  return useMemo(() => {
    const items = role
      ? (() => {
          const allowed = new Set(visibleNavSections(role, visibleTabs))
          const filtered = DEFAULT_NAV.filter(it => allowed.has(it.id))
          if (allowed.has('settings')) filtered.push(SETTINGS_APP)
          return filtered
        })()
      : [...DEFAULT_NAV]
    return items.map(it => ({
      id: it.id,
      label: it.label.replace(/^⚙\s*/, ''),
      href: it.kind === 'link' ? (it.href || '/') : `/dashboard?s=${it.section}`,
      accent: it.dot,
      alertKey: it.alertKey,
    }))
  }, [role, visibleTabs])
}

// ── Shared grid of app tiles ────────────────────────────────────────
export function AppGrid({
  apps, onPick, alertCounts = {}, large = false,
}: {
  apps: LauncherApp[]
  onPick: (app: LauncherApp) => void
  alertCounts?: { invoices?: number; payables?: number }
  large?: boolean
}) {
  const tile = large ? 132 : 112
  const icon = large ? 34 : 28
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))`,
      gap: 14,
      width: '100%',
    }}>
      {apps.map(app => {
        const alert = app.alertKey ? (alertCounts[app.alertKey] || 0) : 0
        return (
          <button
            key={app.id}
            onClick={() => onPick(app)}
            style={{
              position: 'relative',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
              padding: large ? '22px 12px' : '18px 10px',
              background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14,
              cursor: 'pointer', fontFamily: 'inherit', color: T.text2,
              transition: 'transform 0.12s ease, border-color 0.12s ease, background 0.12s ease',
            }}
            onMouseEnter={e => {
              const el = e.currentTarget
              el.style.transform = 'translateY(-3px)'
              el.style.borderColor = app.accent
              el.style.background = T.bg3
            }}
            onMouseLeave={e => {
              const el = e.currentTarget
              el.style.transform = 'translateY(0)'
              el.style.borderColor = T.border
              el.style.background = T.bg2
            }}
          >
            <div style={{
              width: large ? 60 : 52, height: large ? 60 : 52, borderRadius: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `${app.accent}1f`, color: app.accent,
              border: `1px solid ${app.accent}33`,
            }}>
              <AppIcon name={app.id} size={icon}/>
            </div>
            <span style={{
              fontSize: 12.5, fontWeight: 500, color: T.text, textAlign: 'center',
              lineHeight: 1.25,
            }}>{app.label}</span>
            {alert > 0 && (
              <span style={{
                position: 'absolute', top: 10, right: 10,
                minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
                background: T.red, color: '#fff', fontSize: 10, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'monospace',
              }}>{alert}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export interface PortalTopBarProps {
  activeId: string
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

export default function PortalTopBar({
  activeId,
  lastRefresh,
  onRefresh,
  refreshing,
  alertCounts = {},
  currentUserRole,
  currentUserVisibleTabs,
  currentUserName,
  currentUserEmail,
}: PortalTopBarProps) {
  const router = useRouter()
  const apps = useVisibleApps(currentUserRole, currentUserVisibleTabs)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')

  const activeApp = apps.find(a => a.id === activeId) || null

  // Esc closes the launcher / menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLauncherOpen(false); setMenuOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Close launcher on navigation.
  useEffect(() => {
    const close = () => { setLauncherOpen(false); setMenuOpen(false) }
    router.events.on('routeChangeStart', close)
    return () => router.events.off('routeChangeStart', close)
  }, [router])

  const pick = useCallback((app: LauncherApp) => {
    setLauncherOpen(false)
    router.push(app.href)
  }, [router])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(a => a.label.toLowerCase().includes(q))
  }, [apps, query])

  async function handleSignOut() {
    try {
      try { await getSupabase().auth.signOut() } catch {}
      await fetch('/api/auth/session', { method: 'DELETE' }).catch(() => {})
    } finally {
      router.push('/login')
    }
  }

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 7,
    background: 'transparent', border: `1px solid ${T.border}`, color: T.text2,
    borderRadius: 8, padding: '7px 11px', fontSize: 13, fontFamily: 'inherit',
    cursor: 'pointer', outline: 'none', whiteSpace: 'nowrap',
  }

  return (
    <>
      <header style={{
        position: 'sticky', top: 0, zIndex: 900,
        height: TOPBAR_HEIGHT, minHeight: TOPBAR_HEIGHT,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px',
        background: T.bg2, borderBottom: `1px solid ${T.border}`,
        fontFamily: "'DM Sans', system-ui, sans-serif",
      }}>
        {/* Logo → home */}
        <button onClick={() => router.push('/home')} title="Home"
          style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#fff' }}>JA</div>
          <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Just Autos</span>
        </button>

        {/* Apps launcher button */}
        <button onClick={() => setLauncherOpen(o => !o)} style={btn} title="All apps">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
            <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
          </svg>
          Apps
        </button>

        {/* Current app title */}
        {activeApp && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.text, fontSize: 14, fontWeight: 600 }}>
            <span style={{ color: activeApp.accent, display: 'flex' }}><AppIcon name={activeApp.id} size={18}/></span>
            {activeApp.label}
          </div>
        )}

        <span style={{ flex: 1 }}/>

        {onRefresh && (
          <button onClick={onRefresh} disabled={refreshing} style={{ ...btn, opacity: refreshing ? 0.6 : 1 }}
            title={lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}>
            {refreshing ? 'Refreshing…' : '↻ Refresh'}
          </button>
        )}

        {/* User menu */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setMenuOpen(o => !o)} style={btn}>
            <div style={{ width: 24, height: 24, borderRadius: '50%', background: T.bg4, color: T.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
              {(currentUserName || currentUserEmail || '?').trim().charAt(0).toUpperCase()}
            </div>
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentUserName || currentUserEmail || 'Account'}</span>
            <span style={{ fontSize: 9, color: T.text3 }}>▾</span>
          </button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 901 }}/>
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 902,
                minWidth: 200, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10,
                boxShadow: '0 14px 40px rgba(0,0,0,0.45)', padding: 6,
              }}>
                {(currentUserName || currentUserEmail) && (
                  <div style={{ padding: '8px 10px', borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
                    <div style={{ fontSize: 12.5, color: T.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentUserName || currentUserEmail}</div>
                    {currentUserRole && <div style={{ fontSize: 10, color: T.text3, textTransform: 'capitalize', marginTop: 2 }}>{currentUserRole}</div>}
                  </div>
                )}
                {apps.some(a => a.id === 'settings') && (
                  <button onClick={() => { setMenuOpen(false); router.push('/settings') }} style={menuItemStyle()}>⚙ Settings</button>
                )}
                <button onClick={handleSignOut} style={menuItemStyle()}>Sign out →</button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* Launcher overlay */}
      {launcherOpen && (
        <div
          onClick={() => setLauncherOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 950,
            background: 'rgba(8,10,13,0.82)', backdropFilter: 'blur(6px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '64px 24px 24px', overflowY: 'auto',
          }}
        >
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 960 }}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search apps…"
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 20,
                background: T.bg2, border: `1px solid ${T.border2}`, color: T.text,
                borderRadius: 10, padding: '12px 16px', fontSize: 15, fontFamily: 'inherit', outline: 'none',
              }}
            />
            <AppGrid apps={filtered} onPick={pick} alertCounts={alertCounts} large/>
            {filtered.length === 0 && (
              <div style={{ color: T.text3, fontSize: 13, textAlign: 'center', padding: 24 }}>No apps match “{query}”.</div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function menuItemStyle(): React.CSSProperties {
  return {
    display: 'block', width: '100%', textAlign: 'left',
    background: 'none', border: 'none', color: T.text2,
    padding: '8px 10px', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
  }
}

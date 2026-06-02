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
import { usePreferences } from './preferences'
import { useIsMobile } from './useIsMobile'
import { useNotificationSummary, timeAgo, NotificationRow } from './useNotifications'

// Per-module unread badge counts, keyed by app/module id (plus the legacy
// 'invoices'/'payables'/'messages' alert keys, which equal their module ids).
export type AlertCounts = Record<string, number | undefined>

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
  label: string          // custom label if the user renamed it, else defaultLabel
  defaultLabel: string   // the built-in name (for placeholders / reset)
  href: string
  accent: string
  alertKey?: string
}

// Resolve the apps this user can see, in DEFAULT_NAV order, mapped to
// launcher tiles. Section-kind items (invoices/pnl/stock/payables) route
// through /dashboard like the sidebar did. Per-user app_labels (set on
// the home launcher) override the display label everywhere apps appear.
export function useVisibleApps(role?: UserRole, visibleTabs?: string[] | null): LauncherApp[] {
  const { prefs } = usePreferences()
  const labels = prefs.app_labels || {}
  return useMemo(() => {
    const items = role
      ? (() => {
          const allowed = new Set(visibleNavSections(role, visibleTabs))
          const filtered = DEFAULT_NAV.filter(it => allowed.has(it.id))
          if (allowed.has('settings')) filtered.push(SETTINGS_APP)
          return filtered
        })()
      : [...DEFAULT_NAV]
    return items.map(it => {
      const defaultLabel = it.label.replace(/^⚙\s*/, '')
      const custom = labels[it.id]
      return {
        id: it.id,
        label: (custom && custom.trim()) ? custom : defaultLabel,
        defaultLabel,
        href: it.kind === 'link' ? (it.href || '/') : `/dashboard?s=${it.section}`,
        accent: it.dot,
        alertKey: it.alertKey,
      }
    })
  }, [role, visibleTabs, labels])
}

// ── Shared grid of app tiles ────────────────────────────────────────
export function AppGrid({
  apps, onPick, alertCounts = {}, large = false,
}: {
  apps: LauncherApp[]
  onPick: (app: LauncherApp) => void
  alertCounts?: AlertCounts
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
        const alert = (alertCounts[app.id] ?? (app.alertKey ? alertCounts[app.alertKey] : 0)) || 0
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
  // Accepted for drop-in compatibility with the old sidebar (the
  // dashboard passed it for in-page section switching). The top bar
  // routes to sections via the launcher instead, so it's ignored here.
  onSectionClick?: (section: any) => void
  lastRefresh?: Date | null
  onRefresh?: () => void
  refreshing?: boolean
  alertCounts?: AlertCounts
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
  const isMobile = useIsMobile()
  const apps = useVisibleApps(currentUserRole, currentUserVisibleTabs)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')

  const activeApp = apps.find(a => a.id === activeId) || null

  // Cross-page unread badges: one 30s poll covers per-module notification
  // counts AND the messaging unread total. Counts the page passes in via
  // alertCounts (e.g. /messages live count, dashboard invoices/payables)
  // take precedence over the polled values.
  const { summary, refresh: refreshSummary } = useNotificationSummary()
  const mergedAlerts: AlertCounts = {
    ...(summary?.byModule || {}),
    messages: typeof alertCounts.messages === 'number' ? alertCounts.messages : (summary?.messages ?? 0),
    ...Object.fromEntries(Object.entries(alertCounts).filter(([, v]) => typeof v === 'number')),
  }

  // Bell dropdown state — list fetched on open.
  const [bellOpen, setBellOpen] = useState(false)
  const [notifs, setNotifs] = useState<NotificationRow[] | null>(null)
  useEffect(() => {
    if (!bellOpen) return
    fetch('/api/notifications').then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNotifs(d.notifications) }).catch(() => {})
  }, [bellOpen])

  const markRead = useCallback((body: { id?: string; all?: boolean }) => {
    return fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => refreshSummary()).catch(() => {})
  }, [refreshSummary])

  const deleteNotifs = useCallback((body: { id?: string; all?: boolean }) => {
    setNotifs(list => body.all ? [] : (list || []).filter(x => x.id !== body.id))
    return fetch('/api/notifications', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => refreshSummary()).catch(() => {})
  }, [refreshSummary])

  function openNotification(n: NotificationRow) {
    setBellOpen(false)
    if (!n.read_at) {
      setNotifs(list => (list || []).map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))
      markRead({ id: n.id })
    }
    if (n.href) router.push(n.href)
  }

  // Esc closes the launcher / menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLauncherOpen(false); setMenuOpen(false); setBellOpen(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Close launcher on navigation.
  useEffect(() => {
    const close = () => { setLauncherOpen(false); setMenuOpen(false); setBellOpen(false) }
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
          {!isMobile && <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Just Autos</span>}
        </button>

        {/* Apps launcher button */}
        <button onClick={() => setLauncherOpen(o => !o)} style={{ ...btn, ...(isMobile ? { padding: '7px 9px' } : {}) }} title="All apps">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>
            <rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>
          </svg>
          {!isMobile && 'Apps'}
          {(mergedAlerts.messages || 0) > 0 && (
            <span title={`${mergedAlerts.messages} unread message${mergedAlerts.messages === 1 ? '' : 's'}`} style={{ fontSize: 10, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '0 6px', marginLeft: 2 }}>{mergedAlerts.messages}</span>
          )}
        </button>

        {/* Current app title (icon-only on mobile to save room) */}
        {activeApp && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.text, fontSize: 14, fontWeight: 600, minWidth: 0 }}>
            <span style={{ color: activeApp.accent, display: 'flex' }}><AppIcon name={activeApp.id} size={18}/></span>
            {!isMobile && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeApp.label}</span>}
          </div>
        )}

        <span style={{ flex: 1 }}/>

        {/* Notification bell */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={() => setBellOpen(o => !o)} style={{ ...btn, padding: '7px 9px', position: 'relative' }} aria-label="Notifications" title="Notifications">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.7 21a2 2 0 0 1-3.4 0"/>
            </svg>
            {(summary?.total || 0) > 0 && (
              <span style={{
                position: 'absolute', top: -5, right: -5,
                minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                background: T.red, color: '#fff', fontSize: 9.5, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace',
              }}>{summary!.total > 99 ? '99+' : summary!.total}</span>
            )}
          </button>
          {bellOpen && (
            <>
              <div onClick={() => setBellOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 901 }}/>
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: isMobile ? -60 : 0, zIndex: 902,
                width: isMobile ? 'calc(100vw - 24px)' : 360, maxWidth: 'calc(100vw - 24px)',
                maxHeight: '70vh', overflowY: 'auto',
                background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10,
                boxShadow: '0 14px 40px rgba(0,0,0,0.45)', padding: 6,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 8px', borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>Notifications</span>
                  <span style={{ flex: 1 }}/>
                  {(summary?.total || 0) > 0 && (
                    <button
                      onClick={() => { markRead({ all: true }); setNotifs(list => (list || []).map(x => ({ ...x, read_at: x.read_at || new Date().toISOString() }))) }}
                      style={{ background: 'none', border: 'none', color: T.blue, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', padding: 0 }}>
                      Mark all read
                    </button>
                  )}
                  {(notifs?.length || 0) > 0 && (
                    <button
                      onClick={() => { if (confirm('Delete all notifications?')) deleteNotifs({ all: true }) }}
                      style={{ background: 'none', border: 'none', color: T.text3, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', padding: 0, marginLeft: 12 }}>
                      Clear all
                    </button>
                  )}
                </div>
                {notifs === null && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>Loading…</div>}
                {notifs !== null && notifs.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>No notifications yet.</div>}
                {(notifs || []).map(n => {
                  const app = apps.find(a => a.id === n.module)
                  const unread = !n.read_at
                  return (
                    <div key={n.id} onClick={() => openNotification(n)} style={{
                      display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left',
                      background: unread ? 'rgba(79,142,247,0.07)' : 'none', borderRadius: 7,
                      padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 1, boxSizing: 'border-box',
                    }}>
                      <span style={{
                        width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginTop: 1,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: `${app?.accent || T.blue}1f`, color: app?.accent || T.blue,
                      }}>
                        <AppIcon name={n.module} size={15}/>
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 12.5, fontWeight: unread ? 600 : 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                        {n.body && <span style={{ display: 'block', fontSize: 11.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{n.body}</span>}
                      </span>
                      <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>{timeAgo(n.created_at)}</span>
                      {unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: T.red, flexShrink: 0, marginTop: 6 }}/>}
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteNotifs({ id: n.id }) }}
                        title="Delete notification"
                        aria-label="Delete notification"
                        style={{
                          background: 'none', border: 'none', color: T.text3, fontSize: 14, lineHeight: 1,
                          cursor: 'pointer', padding: '2px 3px', marginTop: 1, flexShrink: 0, borderRadius: 4,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.color = T.red }}
                        onMouseLeave={e => { e.currentTarget.style.color = T.text3 }}
                      >×</button>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {onRefresh && (
          <button onClick={onRefresh} disabled={refreshing} style={{ ...btn, opacity: refreshing ? 0.6 : 1, ...(isMobile ? { padding: '7px 9px' } : {}) }}
            title={lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}` : 'Refresh'}>
            {isMobile ? '↻' : (refreshing ? 'Refreshing…' : '↻ Refresh')}
          </button>
        )}

        {/* User menu — avatar-only on mobile so it never pushes off-screen */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={() => setMenuOpen(o => !o)} style={{ ...btn, ...(isMobile ? { padding: 4, gap: 0 } : {}) }} aria-label="Account menu">
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: T.bg4, color: T.text, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>
              {(currentUserName || currentUserEmail || '?').trim().charAt(0).toUpperCase()}
            </div>
            {!isMobile && <>
              <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentUserName || currentUserEmail || 'Account'}</span>
              <span style={{ fontSize: 9, color: T.text3 }}>▾</span>
            </>}
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
            <AppGrid apps={filtered} onPick={pick} alertCounts={mergedAlerts} large/>
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

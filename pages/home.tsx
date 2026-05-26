// pages/home.tsx
// Odoo-style app launcher — the portal's landing page. A grid of app
// tiles, role-filtered, with search-as-you-type. Replaces the old
// straight-to-first-tab redirect (pages/index.tsx now points here).

import { useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../lib/authServer'
import type { UserRole } from '../lib/permissions'
import { AppGrid, useVisibleApps, LauncherApp } from '../lib/PortalTopBar'
import { getSupabase } from '../lib/supabaseClient'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7',
}

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, null)
}

interface Props {
  user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null }
}

export default function HomePage({ user }: Props) {
  const router = useRouter()
  const apps = useVisibleApps(user.role, user.visibleTabs)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return apps
    return apps.filter(a => a.label.toLowerCase().includes(q))
  }, [apps, query])

  function pick(app: LauncherApp) { router.push(app.href) }

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
        {/* Slim header */}
        <header style={{
          height: 56, display: 'flex', alignItems: 'center', gap: 10,
          padding: '0 18px', borderBottom: `1px solid ${T.border}`, background: T.bg2,
        }}>
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
          <div style={{ fontSize: 14, color: T.text3, marginBottom: 26 }}>Pick an app to get started.</div>

          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search apps…"
            style={{
              width: '100%', boxSizing: 'border-box', marginBottom: 24,
              background: T.bg2, border: `1px solid ${T.border2}`, color: T.text,
              borderRadius: 10, padding: '12px 16px', fontSize: 15, fontFamily: 'inherit', outline: 'none',
            }}
          />

          <AppGrid apps={filtered} onPick={pick} large/>
          {filtered.length === 0 && (
            <div style={{ color: T.text3, fontSize: 13, textAlign: 'center', padding: 28 }}>No apps match “{query}”.</div>
          )}
        </main>
      </div>
    </>
  )
}

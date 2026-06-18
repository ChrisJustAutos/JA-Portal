// components/UpdateNotifier.tsx
// Watches for a newer portal deploy and prompts the user to reload so the
// update actually applies (open tabs otherwise keep running the old bundle).
//
// How it knows: the client bundle bakes in NEXT_PUBLIC_BUILD_ID at build time
// (next.config.js, from the Vercel commit SHA). /api/version returns the
// currently-deployed build id at runtime. When they differ, a new version has
// shipped. The SW serves navigations network-first and only caches immutable
// hashed assets, so a plain location.reload() cleanly loads the new version.
//
// Mounted globally in _app (staff, B2B and supplier portals all benefit).

import { useEffect, useRef, useState } from 'react'

const MINE = process.env.NEXT_PUBLIC_BUILD_ID || 'dev'
const POLL_MS = 60_000

export default function UpdateNotifier() {
  const [latest, setLatest] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // No meaningful version to compare against in dev / local builds.
    if (!MINE || MINE === 'dev') return
    let alive = true

    const check = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' })
        if (!r.ok) return
        const j = await r.json()
        if (alive && j?.version && j.version !== 'dev') setLatest(String(j.version))
      } catch { /* offline / transient — try again next tick */ }
    }

    check()
    timer.current = setInterval(check, POLL_MS)
    const onVis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      if (timer.current) clearInterval(timer.current)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const updateAvailable = !!latest && latest !== MINE && latest !== dismissed
  if (!updateAvailable) return null

  function reload() {
    // Activate any waiting SW first (best-effort), then hard-reload.
    try {
      navigator.serviceWorker?.getRegistration?.().then(reg => {
        reg?.waiting?.postMessage('skipWaiting')
      }).catch(() => {})
    } catch { /* ignore */ }
    window.location.reload()
  }

  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', left: '50%', transform: 'translateX(-50%)',
      bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))', zIndex: 100000,
      display: 'flex', alignItems: 'center', gap: 14,
      maxWidth: 'min(520px, calc(100vw - 24px))',
      padding: '11px 14px 11px 16px',
      background: 'var(--t-bg2)', color: 'var(--t-text)',
      border: '1px solid var(--accent, #4f8ef7)',
      borderRadius: 12, boxShadow: '0 12px 36px rgba(0,0,0,0.34)',
      fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 13.5,
    }}>
      <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>🔄</span>
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 600 }}>A new version of the portal is available</div>
        <div style={{ fontSize: 12, color: 'var(--t-text2)' }}>Reload to get the latest update.</div>
      </div>
      <button onClick={reload} style={{
        background: 'var(--accent, #4f8ef7)', color: '#fff', border: 'none',
        borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600,
        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}>Reload</button>
      <button onClick={() => setDismissed(latest)} aria-label="Dismiss" style={{
        background: 'transparent', border: 'none', color: 'var(--t-text3)',
        fontSize: 18, lineHeight: 1, cursor: 'pointer', fontFamily: 'inherit', padding: '0 2px',
      }}>×</button>
    </div>
  )
}

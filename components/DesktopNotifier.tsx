// components/DesktopNotifier.tsx
// Tier-1 desktop pop-ups: while the portal (or installed PWA) is open, show an
// OS toast for any NEW notification. Mounted ONCE in _app so it's a single
// app-wide instance (no duplicate toasts) and works on every page.
//
// Reads /api/notifications, which is already access-scoped to the user's
// visible modules, so toasts respect permissions automatically. Chat messages
// are NOT in this table (they have their own toast in ChatApp), so no overlap.
//
// "New" = unread + created after the last-seen timestamp (persisted in
// localStorage; seeded to "now" on first run so we never toast a backlog).
// Tier-2 (web push when the app is closed) will build on this.

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'

const LAST_SEEN_KEY = 'ja-notif-last-seen'
const POLL_MS = 45000
const SKIP_PATHS = ['/login', '/reset-password', '/b2b']  // not staff-notification pages

export default function DesktopNotifier() {
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const lastSeen = useRef(0)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return

    const stored = Number(window.localStorage.getItem(LAST_SEEN_KEY) || '0')
    lastSeen.current = stored > 0 ? stored : Date.now()
    if (!stored) window.localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current))

    // Ask once, best-effort (matches the messaging permission prompt).
    if (Notification.permission === 'default') { try { Notification.requestPermission() } catch {} }

    let live = true
    async function poll() {
      if (!live || Notification.permission !== 'granted') return
      const path = routerRef.current.pathname || ''
      if (SKIP_PATHS.some((p) => path.startsWith(p))) return
      try {
        const r = await fetch('/api/notifications', { credentials: 'same-origin' })
        if (!r.ok) return
        const { notifications } = await r.json()
        const fresh = (notifications || [])
          .filter((n: any) => !n.read_at && Date.parse(n.created_at) > lastSeen.current)
          .sort((a: any, b: any) => Date.parse(a.created_at) - Date.parse(b.created_at))
        if (!fresh.length) return
        // Cap the burst so a backlog can't flood the OS tray.
        for (const n of fresh.slice(-4)) {
          try {
            const toast = new Notification(n.title || 'Just Autos Portal', {
              body: n.body || '',
              tag: n.id,                 // dedupes if the same one fires twice
              icon: '/icons/icon-192.png',
              badge: '/icons/icon-192.png',
            })
            toast.onclick = () => {
              window.focus()
              if (n.href) routerRef.current.push(n.href)
              toast.close()
            }
          } catch { /* ignore individual toast failures */ }
        }
        const maxTs = Math.max(...fresh.map((n: any) => Date.parse(n.created_at)))
        lastSeen.current = Math.max(lastSeen.current, maxTs)
        window.localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current))
      } catch { /* network blip — try next tick */ }
    }

    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => { live = false; clearInterval(timer) }
  }, [])

  return null
}

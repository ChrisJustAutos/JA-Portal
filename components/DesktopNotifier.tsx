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
import { playSound, primeAudio } from '../lib/notificationSounds'
import { ensurePushSubscription, keepPushFresh, installPushAutoHeal } from '../lib/pushClient'

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

    // Ask once, best-effort (matches the messaging permission prompt), then
    // register for background Web Push if it's granted.
    if (Notification.permission === 'default') {
      try { Notification.requestPermission().then((p) => { if (p === 'granted') ensurePushSubscription() }) } catch {}
    } else if (Notification.permission === 'granted') {
      keepPushFresh()           // self-heals a stale iOS subscription on cold start
    }
    installPushAutoHeal()       // re-arm when the app/service worker updates

    // Unlock audio on the first user interaction (browsers block sound until
    // the user has interacted with the page).
    const prime = () => { primeAudio() }
    window.addEventListener('pointerdown', prime, { once: true })
    window.addEventListener('keydown', prime, { once: true })

    let live = true
    async function poll() {
      if (!live) return
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

        // Always advance the marker (incl. messages) so nothing re-fires.
        const maxTs = Math.max(...fresh.map((n: any) => Date.parse(n.created_at)))
        lastSeen.current = Math.max(lastSeen.current, maxTs)
        window.localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current))

        // Chat messages have their own instant toast (ChatApp) + background
        // push, so skip them here to avoid a duplicate/laggy pop-up.
        const toToast = fresh.filter((n: any) => n.module !== 'messages')
        if (!toToast.length) return

        // Play the chosen sound once per batch (independent of OS permission).
        try { playSound() } catch { /* sound optional */ }

        // OS toasts only if the user granted notification permission.
        if (Notification.permission === 'granted') {
          for (const n of toToast.slice(-4)) {  // cap so a backlog can't flood the tray
            try {
              const toast = new Notification(n.title || 'Just Autos Portal', {
                body: n.body || '',
                tag: n.id,
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
        }
      } catch { /* network blip — try next tick */ }
    }

    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('pointerdown', prime)
      window.removeEventListener('keydown', prime)
    }
  }, [])

  return null
}

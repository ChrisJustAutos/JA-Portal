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

const LAST_SEEN_KEY = 'ja-notif-last-seen'
const POLL_MS = 45000
const SKIP_PATHS = ['/login', '/reset-password', '/b2b']  // not staff-notification pages

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// Subscribe this browser to Web Push so notifications arrive even when the app
// is closed. Safe no-op without a configured VAPID key or SW support. Idempotent.
async function ensurePushSubscription() {
  try {
    const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapid) return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      })
    }
    await fetch('/api/notifications/push-subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    }).catch(() => {})
  } catch { /* push optional — ignore */ }
}

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
      ensurePushSubscription()
    }

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

        // Play the chosen sound once per batch (independent of OS permission).
        try { playSound() } catch { /* sound optional */ }

        // OS toasts only if the user granted notification permission.
        if (Notification.permission === 'granted') {
          for (const n of fresh.slice(-4)) {  // cap so a backlog can't flood the tray
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
        const maxTs = Math.max(...fresh.map((n: any) => Date.parse(n.created_at)))
        lastSeen.current = Math.max(lastSeen.current, maxTs)
        window.localStorage.setItem(LAST_SEEN_KEY, String(lastSeen.current))
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

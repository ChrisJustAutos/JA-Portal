// public/sw.js — Just Autos Portal service worker (makes the PWA installable).
//
// DELIBERATELY MINIMAL + SAFE for an authenticated, live-data portal:
//   • Only same-origin GET requests are ever considered.
//   • /api/* is NEVER cached (live data + auth — always network).
//   • POST/PATCH/DELETE and cross-origin (Supabase, MYOB, etc.) pass straight
//     through, untouched.
//   • Only content-hashed static assets (/_next/static, /icons) are cached —
//     they're immutable, so there's zero staleness or cross-user leak risk.
//   • HTML navigations are network-first (so you always get fresh, correctly
//     authenticated pages) and only fall back to a small offline page when
//     the network is genuinely unavailable.
//
// Bump VERSION whenever this file or offline.html changes, to evict old caches.

const VERSION = 'v5'
const CACHE = `ja-portal-static-${VERSION}`
const PRECACHE = ['/offline.html', '/icons/icon-192.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return            // never cache writes
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return  // skip Supabase/MYOB/etc.
  if (url.pathname.startsWith('/api/')) return     // never cache API/auth

  // The manifest must always be fresh so start_url / icon changes propagate
  // to installed apps without a reinstall — never cache it.
  if (url.pathname === '/manifest.json') return

  // Immutable static assets → cache-first (fast loads, safe to keep).
  const isStatic =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/')
  if (isStatic) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
      )
    )
    return
  }

  // Page navigations → network-first; offline fallback only on failure.
  // The authenticated HTML itself is never stored.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/offline.html'))
    )
    return
  }

  // Everything else: straight to the network.
})

// Allow the page to tell a freshly-installed SW to take over immediately, and
// to hand us the push config (VAPID key + subscribe URL) so we can re-subscribe
// ourselves on `pushsubscriptionchange` even while the app is closed.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') { self.skipWaiting(); return }
  if (event.data && event.data.type === 'push-config' && event.data.vapid) {
    event.waitUntil(savePushConfig({ vapid: event.data.vapid, subscribeUrl: event.data.subscribeUrl || '/api/notifications/push-subscribe' }))
  }
})

// ── Push subscription self-heal ────────────────────────────────────────────
// Browsers (Chrome/FCM especially) rotate/expire push subscriptions; when that
// happens the SW gets `pushsubscriptionchange`. If unhandled, the server's
// endpoint goes dead and nothing re-registers until the user reopens the app —
// which is why closed-app notifications "drop out". Here we re-subscribe and
// re-register the fresh endpoint immediately, no app open required.
const PUSH_CFG_CACHE = 'ja-push-config'
async function savePushConfig(cfg) {
  try { const c = await caches.open(PUSH_CFG_CACHE); await c.put('cfg', new Response(JSON.stringify(cfg))) } catch {}
}
async function loadPushConfig() {
  try { const c = await caches.open(PUSH_CFG_CACHE); const r = await c.match('cfg'); return r ? await r.json() : null } catch { return null }
}
function urlBase64ToUint8Array(base64) {
  const clean = String(base64).replace(/\s+/g, '')
  const padding = '='.repeat((4 - (clean.length % 4)) % 4)
  const b64 = (clean + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const cfg = await loadPushConfig()
    if (!cfg || !cfg.vapid) return
    try {
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapid),
      })
      await fetch(cfg.subscribeUrl, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      })
    } catch (e) { /* best-effort; the page-side ensure will recover on next open */ }
  })())
})

// ── Web Push (fires even when the app is closed) ───────────────────────────
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const title = data.title || 'Just Autos Portal'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { href: data.href || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const href = (event.notification.data && event.notification.data.href) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Focus an existing window and navigate it; else open a new one.
      for (const w of wins) {
        if ('focus' in w) {
          w.focus()
          if ('navigate' in w) { try { w.navigate(href) } catch {} }
          return
        }
      }
      return self.clients.openWindow(href)
    })
  )
})

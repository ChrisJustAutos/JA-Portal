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

const VERSION = 'v4'
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

// Allow the page to tell a freshly-installed SW to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting()
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

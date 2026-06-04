// lib/pushClient.ts
// Client helpers for enabling notifications + registering this browser for
// Web Push. The permission prompt must be triggered from a user gesture (a
// click) — browsers (and iOS especially) suppress page-load requests — so the
// bell's "Enable notifications" button calls enableNotifications().

function urlBase64ToUint8Array(base64: string): Uint8Array {
  // Strip any whitespace/newlines that may have been pasted into the env var —
  // a stray char makes atob throw "The string contains invalid characters".
  const clean = String(base64).replace(/\s+/g, '')
  const padding = '='.repeat((4 - (clean.length % 4)) % 4)
  const b64 = (clean + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export interface PushResult { ok: boolean; reason?: string }

// Subscribe this browser to Web Push (idempotent). Returns a reason on failure
// so the UI can show why it didn't register. `subscribeUrl` lets the B2B
// distributor portal store the subscription against its own user table.
export async function ensurePushSubscription(subscribeUrl = '/api/notifications/push-subscribe', opts: { force?: boolean } = {}): Promise<PushResult> {
  const vapid = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').replace(/\s+/g, '')
  if (!vapid) return { ok: false, reason: 'server push key missing in this build' }
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return { ok: false, reason: 'service workers not supported' }
  if (typeof window === 'undefined' || !('PushManager' in window)) return { ok: false, reason: 'push not supported on this browser' }
  try {
    // Don't wait forever if the SW never activates.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((res) => setTimeout(() => res(null), 8000)),
    ])
    if (!reg) return { ok: false, reason: 'service worker not active — reopen the app' }
    let sub = await reg.pushManager.getSubscription()
    // Recovery path: iOS can silently invalidate a subscription server-side while
    // getSubscription() still returns the old (dead) object — so re-saving it
    // never heals delivery. `force` drops the existing one and mints a fresh
    // endpoint, which is what the "Re-register this device" button needs.
    if (sub && opts.force) { try { await sub.unsubscribe() } catch {} sub = null }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      })
    }
    const r = await fetch(subscribeUrl, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    })
    if (!r.ok) return { ok: false, reason: `couldn’t save subscription (HTTP ${r.status})` }
    // Hand the SW the config so it can re-subscribe itself if the browser
    // rotates/expires the subscription while the app is closed.
    try { (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'push-config', vapid, subscribeUrl }) } catch {}
    return { ok: true }
  } catch (e: any) {
    return { ok: false, reason: e?.message ? String(e.message).slice(0, 100) : 'subscribe failed' }
  }
}

// Keep this device's push subscription alive WITHOUT manual re-registration.
// iOS silently invalidates subscriptions (commonly across an app/SW update)
// while getSubscription() keeps returning the dead object — so a plain ensure
// re-saves a corpse and never heals. On the installed PWA we therefore force a
// fresh endpoint on cold start, throttled to ~once / 6h per device (dead
// endpoints are pruned server-side on the next send). In a normal desktop
// browser tab subscriptions are stable, so there we just ensure (no force).
export async function keepPushFresh(subscribeUrl = '/api/notifications/push-subscribe'): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  const standalone = (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
    || (navigator as any).standalone === true
  let force = false
  const KEY = 'ja-push-fresh:' + subscribeUrl
  try {
    const last = Number(localStorage.getItem(KEY) || '0')
    if (standalone && Date.now() - last > 6 * 60 * 60 * 1000) force = true
  } catch { /* ignore */ }
  const res = await ensurePushSubscription(subscribeUrl, { force })
  if (force && res.ok) { try { localStorage.setItem(KEY, String(Date.now())) } catch {} }
}

// Re-arm push the moment a new service worker takes control (the app updated) —
// iOS frequently drops the subscription across an update. Idempotent; safe to
// call on every mount.
let _autoHealInstalled = false
export function installPushAutoHeal(subscribeUrl = '/api/notifications/push-subscribe'): void {
  if (_autoHealInstalled) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  _autoHealInstalled = true
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      ensurePushSubscription(subscribeUrl, { force: true }).catch(() => {})
    }
  })
}

// Ask for notification permission (call from a click) and subscribe if granted.
// Returns the resulting permission state.
export async function enableNotifications(subscribeUrl = '/api/notifications/push-subscribe'): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  let perm = Notification.permission
  if (perm === 'default') {
    try { perm = await Notification.requestPermission() } catch { /* ignore */ }
  }
  if (perm === 'granted') await ensurePushSubscription(subscribeUrl)
  return perm
}

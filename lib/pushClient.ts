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

// Keep the server's copy of this device's subscription current. Just a plain,
// idempotent ensure (upsert on the SAME endpoint) — NO forcing. Blind forcing
// minted a fresh endpoint on every call, leaving the same device showing up as
// many "devices". Real rotations/expiry are now self-healed by the service
// worker's pushsubscriptionchange handler; genuine recovery is the manual
// "Re-register this device" button.
export async function keepPushFresh(subscribeUrl = '/api/notifications/push-subscribe'): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  await ensurePushSubscription(subscribeUrl)
}

// Re-save the subscription when a new service worker takes control (app
// updated). Non-forced — the push subscription survives SW version changes, so
// we just re-register the existing endpoint (no new device row). Idempotent.
let _autoHealInstalled = false
export function installPushAutoHeal(subscribeUrl = '/api/notifications/push-subscribe'): void {
  if (_autoHealInstalled) return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  _autoHealInstalled = true
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      ensurePushSubscription(subscribeUrl).catch(() => {})
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

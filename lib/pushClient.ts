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
export async function ensurePushSubscription(subscribeUrl = '/api/notifications/push-subscribe'): Promise<PushResult> {
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
    return { ok: true }
  } catch (e: any) {
    return { ok: false, reason: e?.message ? String(e.message).slice(0, 100) : 'subscribe failed' }
  }
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

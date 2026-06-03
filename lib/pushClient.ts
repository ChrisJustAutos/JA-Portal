// lib/pushClient.ts
// Client helpers for enabling notifications + registering this browser for
// Web Push. The permission prompt must be triggered from a user gesture (a
// click) — browsers (and iOS especially) suppress page-load requests — so the
// bell's "Enable notifications" button calls enableNotifications().

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

// Subscribe this browser to Web Push (idempotent). No-op without a configured
// VAPID key or service-worker/push support.
export async function ensurePushSubscription(): Promise<void> {
  try {
    const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    if (!vapid) return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return
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

// Ask for notification permission (call from a click) and subscribe if granted.
// Returns the resulting permission state.
export async function enableNotifications(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  let perm = Notification.permission
  if (perm === 'default') {
    try { perm = await Notification.requestPermission() } catch { /* ignore */ }
  }
  if (perm === 'granted') await ensurePushSubscription()
  return perm
}

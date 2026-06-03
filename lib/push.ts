// lib/push.ts
// SERVER-ONLY. Sends Web Push notifications to a user's subscribed devices,
// so notification pop-ups fire even when the PWA is closed. No-ops cleanly if
// the VAPID env vars aren't configured (so the feature ships dormant).
//
// Env required to activate:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY  (also used client-side to subscribe)
//   VAPID_PRIVATE_KEY
//   VAPID_SUBJECT                 (mailto: address; optional, has a default)

import webpush from 'web-push'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

let _configured: boolean | null = null
function configured(): boolean {
  if (_configured !== null) return _configured
  const pub = (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '').replace(/\s+/g, '')
  const priv = (process.env.VAPID_PRIVATE_KEY || '').replace(/\s+/g, '')
  if (!pub || !priv) { _configured = false; return false }
  try {
    webpush.setVapidDetails((process.env.VAPID_SUBJECT || 'mailto:portal@justautosmechanical.com.au').trim(), pub, priv)
    _configured = true
  } catch { _configured = false }
  return _configured
}

export interface PushPayload { title: string; body?: string | null; href?: string | null; tag?: string }

/**
 * Best-effort push to every subscription of the given users. Never throws.
 * Prunes subscriptions the push service reports as gone (404/410).
 */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<void> {
  try {
    if (!configured() || !userIds.length) return
    const c = sb()
    const { data: subs } = await c.from('push_subscriptions').select('id, endpoint, p256dh, auth').in('user_id', userIds)
    if (!subs?.length) return
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body || '',
      href: payload.href || '/',
      tag: payload.tag,
    })
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
      } catch (e: any) {
        const code = e?.statusCode
        if (code === 404 || code === 410) {
          await c.from('push_subscriptions').delete().eq('id', s.id)
        } else {
          console.error('push send failed:', code || e?.message || e)
        }
      }
    }))
  } catch (e: any) {
    console.error('sendPushToUsers failed (non-fatal):', e?.message || e)
  }
}

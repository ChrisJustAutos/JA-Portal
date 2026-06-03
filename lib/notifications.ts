// lib/notifications.ts
// SERVER-ONLY. Cross-module notification emitter + service client.
//
// notify() is best-effort by design: it must NEVER throw, because it's
// called from inside money paths (Stripe webhook pipeline) and crons.
// Recipients are the union of explicit userIds and all active users whose
// role is in `roles` (role filtering happens in JS, not in the query —
// the user_role SQL enum may not contain every TypeScript role value,
// e.g. 'workshop', and an .in() with an unknown enum value errors).
//
// dedupeKey: pass a stable key (e.g. `b2b-paid:${orderId}`) when the same
// event can be emitted more than once (webhook retries, cron sweeps).
// The (user_id, dedupe_key) unique constraint silently drops repeats.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { visibleNavSections } from './permissions'
import { messageNotificationsMuted } from './preferences'

let _sb: SupabaseClient | null = null
export function notifSvc(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface NotifyOpts {
  module: string            // DEFAULT_NAV id: 'b2b' | 'calls' | 'diary' | 'workshop-tasks' | …
  title: string
  body?: string | null
  href?: string | null
  dedupeKey?: string        // stable key for at-most-once per user
  roles?: string[]          // notify all active users with one of these roles
  userIds?: string[]        // and/or these specific users
  excludeUserId?: string | null  // usually the actor — don't notify yourself
}

export async function notify(opts: NotifyOpts): Promise<void> {
  try {
    const c = notifSvc()
    const ids = new Set<string>(opts.userIds || [])
    if (opts.roles && opts.roles.length) {
      const { data } = await c.from('user_profiles')
        .select('id, role').eq('is_active', true)
      const want = new Set(opts.roles)
      for (const u of data || []) if (want.has(String(u.role))) ids.add(u.id)
    }
    if (opts.excludeUserId) ids.delete(opts.excludeUserId)
    if (ids.size === 0) return

    // Only notify users who can actually SEE this module and haven't muted it.
    // (A user without the Leads tab shouldn't get Leads notifications, etc.)
    const idList = Array.from(ids)
    const [{ data: profiles }, { data: prefRows }] = await Promise.all([
      c.from('user_profiles').select('id, role, visible_tabs').in('id', idList),
      c.from('user_preferences').select('user_id, muted_notif_modules, timezone, messages_away, messages_quiet_enabled, messages_work_start, messages_work_end, messages_work_days').in('user_id', idList),
    ])
    const profById = new Map<string, any>((profiles || []).map((p: any) => [p.id, p]))
    const mutedById = new Map<string, Set<string>>((prefRows || []).map((r: any) => [r.user_id, new Set<string>(Array.isArray(r.muted_notif_modules) ? r.muted_notif_modules.map(String) : [])]))
    const prefsById = new Map<string, any>((prefRows || []).map((r: any) => [r.user_id, r]))
    const eligible = idList.filter(id => {
      const p = profById.get(id)
      if (!p) return false
      const visible = new Set(visibleNavSections(p.role, (p.visible_tabs as string[] | null) || null))
      if (!visible.has(opts.module)) return false           // can't see this module
      if ((mutedById.get(id) || new Set()).has(opts.module)) return false  // muted it
      return true
    })
    if (eligible.length === 0) return

    const rows = eligible.map(user_id => ({
      user_id,
      module: opts.module,
      title: opts.title.slice(0, 200),
      body: opts.body ? String(opts.body).slice(0, 500) : null,
      href: opts.href || null,
      ...(opts.dedupeKey ? { dedupe_key: opts.dedupeKey } : {}),
    }))
    // ignoreDuplicates + .select() returns ONLY the rows actually inserted —
    // so re-fired events (webhook retries) don't re-push to users who already
    // had this notification.
    const { data: inserted, error } = await c.from('notifications')
      .upsert(rows, { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true })
      .select('user_id')
    if (error) { console.error('notify: insert failed:', error.message); return }

    // Web Push (best-effort) to the newly-notified users — fires even when the
    // PWA is closed. No-ops if VAPID isn't configured. (Already filtered to
    // users who can see + haven't muted the module.)
    const freshIds = Array.from(new Set((inserted || []).map((r: any) => r.user_id)))
    if (freshIds.length) {
      // For the Messages module, honour each recipient's "away" / working-hours
      // setting: skip the background push (and the in-app alert it would trigger)
      // while they're away or outside hours. The bell row above is still kept, so
      // nothing is lost — only the active interruption is suppressed.
      const pushIds = opts.module === 'messages'
        ? freshIds.filter(id => !messageNotificationsMuted(prefsById.get(id)))
        : freshIds
      if (pushIds.length) {
        const { sendPushToUsers } = await import('./push')
        await sendPushToUsers(pushIds, { title: opts.title, body: opts.body || null, href: opts.href || null, tag: opts.dedupeKey })
      }
    }
  } catch (e: any) {
    console.error('notify failed (non-fatal):', e?.message || e)
  }
}

// Returns the set of module ids a user has muted (from user_preferences).
// Empty set on any error. Used to suppress bell entries / badges / push.
export async function mutedModulesForUser(userId: string): Promise<Set<string>> {
  try {
    const { data } = await notifSvc().from('user_preferences')
      .select('muted_notif_modules').eq('user_id', userId).maybeSingle()
    const arr = (data as any)?.muted_notif_modules
    return new Set(Array.isArray(arr) ? arr.map((m: any) => String(m)) : [])
  } catch { return new Set() }
}

// Best-effort match of a free-text person name (task assignee, Monday board
// owner / rep first name) to a portal user. Matches display_name prefix,
// case-insensitive. Returns the user id or null.
export async function findUserByName(name: string | null | undefined): Promise<string | null> {
  const q = String(name || '').trim()
  if (!q) return null
  try {
    const c = notifSvc()
    const first = q.split(/\s+/)[0]
    const { data } = await c.from('user_profiles')
      .select('id, display_name').eq('is_active', true)
      .ilike('display_name', `${first}%`).limit(2)
    // Only trust an unambiguous match.
    return data && data.length === 1 ? data[0].id : null
  } catch {
    return null
  }
}

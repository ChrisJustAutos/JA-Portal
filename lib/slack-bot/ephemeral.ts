// lib/slack-bot/ephemeral.ts
//
// Auto-delete for parts-bot answers, so the channel stays clear. Bot replies
// are enqueued with a delete_at (default now + 5 min); the /api/cron/slack-cleanup
// cron sweeps due rows and chat.delete's them. Serverless functions can't be
// held open for 5 minutes, hence the small queue + per-minute cron.
//
// Only the bot's OWN messages are deletable (Slack won't let a bot delete a
// user's message without workspace-admin rights), so staff questions remain.
//
// TTL via SLACK_EPHEMERAL_MINUTES (default 5; set to 0 to disable auto-delete).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { deleteMessage } from './slack'

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

function ttlMinutes(): number {
  const raw = (process.env.SLACK_EPHEMERAL_MINUTES ?? '').trim()
  if (raw === '') return 5
  const n = Number(raw)
  return Number.isFinite(n) ? n : 5
}

export function ephemeralEnabled(): boolean {
  return ttlMinutes() > 0
}

// Enqueue a bot message for deletion after the TTL. Best-effort — never throws
// into the reply path (a failed enqueue just means the message lingers).
export async function scheduleDeletion(channel: string, ts: string): Promise<void> {
  if (!ephemeralEnabled()) return
  try {
    const deleteAt = new Date(Date.now() + ttlMinutes() * 60_000).toISOString()
    await sb().from('slack_ephemeral_messages').insert({ channel, ts, delete_at: deleteAt })
  } catch (e: any) {
    console.error('[slack ephemeral] enqueue failed:', e?.message || e)
  }
}

// Delete all messages whose delete_at has passed. A failed delete is left in the
// queue to retry on the next sweep.
export async function sweepDueDeletions(limit = 200): Promise<{ deleted: number; failed: number; scanned: number }> {
  const db = sb()
  const { data, error } = await db.from('slack_ephemeral_messages')
    .select('id, channel, ts')
    .eq('deleted', false)
    .lte('delete_at', new Date().toISOString())
    .order('delete_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(error.message)

  const rows = data || []
  let deleted = 0, failed = 0
  for (const row of rows) {
    let ok = false
    try { ok = await deleteMessage({ channel: row.channel, ts: row.ts }) } catch { ok = false }
    if (ok) {
      await db.from('slack_ephemeral_messages').update({ deleted: true }).eq('id', row.id)
      deleted++
    } else {
      failed++
    }
  }
  return { deleted, failed, scanned: rows.length }
}

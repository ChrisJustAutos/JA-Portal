// lib/slack-bot/ephemeral.ts
//
// Optional auto-delete for parts-bot answers. OFF by default — we keep full
// history (answers thread under each question). When SLACK_EPHEMERAL_MINUTES is
// a positive number, replies are enqueued with a delete_at and the
// /api/cron/slack-cleanup cron chat.delete's the due ones (serverless can't be
// held open for minutes, hence a small queue + cron).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { deleteMessage } from './slack'

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

function ttlMinutes(): number {
  // Auto-delete is OFF by default — we keep full history (answers thread under
  // each question). Set SLACK_EPHEMERAL_MINUTES to a positive number to bring
  // back ephemeral replies that self-delete after that many minutes.
  const raw = (process.env.SLACK_EPHEMERAL_MINUTES ?? '').trim()
  if (raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
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

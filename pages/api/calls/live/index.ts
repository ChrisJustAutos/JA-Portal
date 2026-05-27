// pages/api/calls/live/index.ts
// GET — list calls currently in progress, for the live monitoring board.
// Reads the snapshot the on-PBX agent pushes to /agent/snapshot. Gated to
// monitor:calls. Returns { configured:false } until the agent has pushed once.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { SNAPSHOT_ID, SNAPSHOT_STALE_MS } from '../../../../lib/live-calls'

export const config = { maxDuration: 10 }

export default withAuth('monitor:calls', async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const [snapRes, extRes] = await Promise.all([
    sb.from('live_call_snapshot').select('calls, updated_at').eq('id', SNAPSHOT_ID).maybeSingle(),
    sb.from('extensions').select('extension, display_name').eq('active', true),
  ])
  if (snapRes.error) return res.status(500).json({ error: snapRes.error.message })

  // extension → staff name, so the board can label each call's agent leg. The
  // snapshot's caller_id_name is unreliable ("<unknown>"), so we resolve the
  // dialled extension against the directory. Best-effort — ignore lookup errors.
  const extensions: Record<string, string> = {}
  for (const e of (extRes.data || [])) {
    if (e.extension && e.display_name) extensions[String(e.extension)] = e.display_name
  }

  const data = snapRes.data
  if (!data) return res.status(200).json({ configured: false, calls: [], extensions })

  const updatedMs = new Date(data.updated_at).getTime()
  const stale = !isFinite(updatedMs) || Date.now() - updatedMs > SNAPSHOT_STALE_MS
  return res.status(200).json({
    configured: true,
    stale,
    updated_at: data.updated_at,
    calls: Array.isArray(data.calls) ? data.calls : [],
    extensions,
  })
})

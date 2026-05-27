// pages/api/workshop/technicians/reorder.ts
// POST { codes: string[] } — set workshop_technicians.sort_order to match the
// given order of lane codes (from drag-reordering the diary). Gated
// edit:bookings so front-desk can reorder lanes without admin rights.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('edit:bookings', async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const codes: string[] = Array.isArray(body.codes) ? body.codes.map((c: any) => String(c)) : []
  if (codes.length === 0) return res.status(400).json({ error: 'codes[] required' })

  const db = sb()
  const now = new Date().toISOString()
  // sort_order = index*10 (10-spacing leaves room for future single inserts).
  const results = await Promise.all(codes.map((code, i) =>
    db.from('workshop_technicians').update({ sort_order: i * 10, updated_at: now }).eq('code', code)
  ))
  const failed = results.find(r => r.error)
  if (failed?.error) return res.status(500).json({ error: failed.error.message })
  return res.status(200).json({ ok: true, ordered: codes.length })
})

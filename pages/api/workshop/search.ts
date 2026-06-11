// pages/api/workshop/search.ts
// GET ?q= — workshop-wide search across customers / vehicles / jobs / invoices.
//
// All matching happens in the workshop_search RPC (migration 092) so it can
// normalise DB-side: phones compare digits-only ("0410 599 778" finds
// "0410599778" and vice versa), rego/VIN compare lowercased with whitespace
// stripped ("254 PE4" finds "254PE4"). Names, emails, customer numbers and
// invoice numbers are plain substring matches.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 10 }

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.status(200).json({ customers: [], vehicles: [], jobs: [], invoices: [] })
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8))

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  const { data, error } = await db.rpc('workshop_search', { p_q: q, p_limit: limit })
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({
    customers: data?.customers || [],
    vehicles: data?.vehicles || [],
    jobs: data?.jobs || [],
    invoices: data?.invoices || [],
  })
})

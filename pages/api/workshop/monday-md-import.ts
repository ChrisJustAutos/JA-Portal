// pages/api/workshop/monday-md-import.ts
//
// Service-token endpoint for the nightly Monday→MD customer import worker
// (scripts/import-monday-leads.ts, GH Actions). Same auth model as the
// stocktake/PO workers (X-Service-Token, scope 'stocktake:write').
//
// GET  ?item_ids=a,b,c → { seen: ["a","c"] } — which Monday items are already
//                        recorded (idempotency across runs).
// POST { rows: [...] } → insert outcome rows into monday_md_customer_imports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../lib/service-auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Invalid or missing X-Service-Token' })
  const c = sb()

  if (req.method === 'GET') {
    const ids = String(req.query.item_ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 500)
    if (!ids.length) return res.status(200).json({ seen: [] })
    const { data, error } = await c.from('monday_md_customer_imports').select('monday_item_id').in('monday_item_id', ids)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ seen: (data || []).map(r => r.monday_item_id) })
  }

  if (req.method === 'POST') {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
    if (!rows.length) return res.status(400).json({ error: 'rows required' })
    const clean = rows.slice(0, 200).map((r: any) => ({
      monday_item_id: String(r.monday_item_id),
      monday_board_id: String(r.monday_board_id || ''),
      channel: r.channel || null,
      customer_name: String(r.customer_name || '').slice(0, 200),
      phone: r.phone || null,
      email: r.email || null,
      postcode: r.postcode || null,
      outcome: ['created', 'exists_md', 'exists_portal', 'skipped', 'error'].includes(r.outcome) ? r.outcome : 'error',
      md_customer_id: r.md_customer_id != null ? String(r.md_customer_id) : null,
      error: r.error ? String(r.error).slice(0, 400) : null,
    }))
    const { error } = await c.from('monday_md_customer_imports').upsert(clean, { onConflict: 'monday_item_id', ignoreDuplicates: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true, inserted: clean.length })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

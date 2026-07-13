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
    // Customer-existence check against the workshop_customers mirror
    // (MD search can't match phone numbers — probed 2026-07-13 — so the
    // worker deduplicates here by phone tail / email instead).
    if (req.query.check === '1') {
      const tail = String(req.query.phone_tail || '').replace(/\D/g, '').slice(-8)
      const email = String(req.query.email || '').trim().toLowerCase()
      const ors: string[] = []
      if (tail.length === 8) ors.push(`phone.ilike.%${tail}`, `mobile.ilike.%${tail}`)
      if (email) ors.push(`email.ilike.${email}`)
      if (!ors.length) return res.status(200).json({ candidates: [] })
      const { data, error } = await c.from('workshop_customers')
        .select('id, md_id, name, phone, mobile, email')
        .or(ors.join(','))
        .limit(10)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ candidates: data || [] })
    }

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

    // Freshen the workshop_customers mirror with anything we just created in
    // MD, so tomorrow's dedup (and portal search) knows about them.
    for (const r of clean.filter((x: any) => x.outcome === 'created' && x.md_customer_id)) {
      try {
        const { data: existing } = await c.from('workshop_customers').select('id').eq('md_id', r.md_customer_id).maybeSingle()
        if (existing) continue
        const parts = r.customer_name.trim().split(/\s+/)
        await c.from('workshop_customers').insert({
          md_id: r.md_customer_id,
          name: r.customer_name,
          first_name: parts[0] || null,
          last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
          mobile: r.phone,
          email: r.email,
          customer_type: 'individual',
        })
      } catch (e: any) {
        console.warn('[monday-md-import] mirror upsert failed:', e?.message)
      }
    }
    return res.status(200).json({ ok: true, inserted: clean.length })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

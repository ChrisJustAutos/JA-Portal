// pages/api/workshop/cash-count.ts
// Cash Count — weigh-count the till on a Live Bins load-cell module.
//   GET  → { denominations, counts } (recent counts, newest first)
//   POST { action:'save', lines, total_cents, expected_cents?, notes? } → { count }
//   POST { action:'setWeight', id, unit_weight_g } — calibrate a denomination
//        (unit weight from a counted sample; null clears → manual-count only)
//
// Live grams come from the existing /api/scales feed (scale_bins.last_grams);
// this endpoint owns only the denomination table + saved counts.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('view:diary', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const c = sb()

  if (req.method === 'GET') {
    const [{ data: denoms, error: dErr }, { data: counts, error: cErr }] = await Promise.all([
      c.from('cash_denominations').select('*').eq('active', true).order('sort'),
      c.from('cash_counts').select('*').order('counted_at', { ascending: false }).limit(20),
    ])
    if (dErr) return res.status(500).json({ error: dErr.message })
    if (cErr) return res.status(500).json({ error: cErr.message })
    return res.status(200).json({ denominations: denoms || [], counts: counts || [] })
  }

  if (req.method === 'POST') {
    const b = req.body || {}
    const act = String(b.action || '')

    if (act === 'save') {
      const lines = Array.isArray(b.lines) ? b.lines : []
      if (!lines.length) return res.status(400).json({ error: 'No lines to save' })
      const total = Math.round(Number(b.total_cents))
      if (!Number.isFinite(total)) return res.status(400).json({ error: 'total_cents required' })
      const expected = b.expected_cents == null || b.expected_cents === '' ? null : Math.round(Number(b.expected_cents))
      const { data, error } = await c.from('cash_counts').insert({
        counted_by: (user as any)?.displayName || (user as any)?.email || null,
        lines,
        total_cents: total,
        expected_cents: expected,
        variance_cents: expected == null ? null : total - expected,
        notes: b.notes ? String(b.notes).slice(0, 500) : null,
      }).select('*').single()
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, count: data })
    }

    if (act === 'setWeight') {
      if (!b.id) return res.status(400).json({ error: 'id required' })
      const w = b.unit_weight_g == null || b.unit_weight_g === '' ? null : Number(b.unit_weight_g)
      if (w !== null && (!Number.isFinite(w) || w <= 0)) return res.status(400).json({ error: 'unit_weight_g must be a positive number of grams' })
      const { error } = await c.from('cash_denominations').update({ unit_weight_g: w }).eq('id', String(b.id))
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: `Unknown action "${act}"` })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

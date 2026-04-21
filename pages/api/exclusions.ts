// pages/api/exclusions.ts
// Admin-only: GET + POST for distributor_report_excluded_customers.
// Separate from distributor-config.ts so the Groups admin page can
// edit the exclusion list without needing to read/write categories.
//
// Note values are constrained (DB CHECK) to one of:
//   'Excluded' — hidden from the distributor report (staff, unwanted)
//   'Sundry'   — surfaced as a dedicated 'Sundry' group on the report
//   'Internal' — hidden (VPS intercompany, related entities)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '../../lib/auth'

const VALID_NOTES = ['Excluded', 'Sundry', 'Internal'] as const
type Note = typeof VALID_NOTES[number]

function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

interface ExcludedRow { id?: string; customer_name: string; note: Note }

async function handleGet(res: NextApiResponse) {
  const sb = sbAdmin()
  const { data, error } = await sb
    .from('distributor_report_excluded_customers')
    .select('id, customer_name, note, created_at')
    .order('customer_name')
  if (error) return res.status(500).json({ error: error.message })
  res.status(200).json({ excluded: data || [] })
}

async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  // Full-replace semantics. The client sends the complete list.
  const body = req.body || {}
  const excluded: ExcludedRow[] = Array.isArray(body.excluded) ? body.excluded : []

  // Validate
  for (const row of excluded) {
    if (!row.customer_name || !String(row.customer_name).trim()) {
      return res.status(400).json({ error: 'customer_name required on every row' })
    }
    if (!VALID_NOTES.includes(row.note)) {
      return res.status(400).json({ error: `note must be one of: ${VALID_NOTES.join(', ')}` })
    }
  }

  const sb = sbAdmin()

  // Clear + insert (simplest; the table is tiny)
  const { error: delErr } = await sb
    .from('distributor_report_excluded_customers')
    .delete()
    .neq('customer_name', '___impossible_placeholder___')
  if (delErr) return res.status(500).json({ error: 'Clear failed: ' + delErr.message })

  if (excluded.length === 0) return res.status(200).json({ ok: true })

  // Dedupe by lowercased customer name
  const seen = new Set<string>()
  const rows = excluded
    .map(r => ({ customer_name: r.customer_name.trim(), note: r.note }))
    .filter(r => {
      const k = r.customer_name.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  const { error: insErr } = await sb
    .from('distributor_report_excluded_customers')
    .insert(rows)
  if (insErr) return res.status(500).json({ error: 'Insert failed: ' + insErr.message })

  res.status(200).json({ ok: true, count: rows.length })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    if (req.method === 'GET')  return handleGet(res)
    if (req.method === 'POST') return handlePost(req, res)
    res.status(405).json({ error: 'Method not allowed' })
  })
}

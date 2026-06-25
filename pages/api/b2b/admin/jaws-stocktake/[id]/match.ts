// pages/api/b2b/admin/jaws-stocktake/[id]/match.ts
//
// Resolve every SKU in the uploaded sheet against MYOB (JAWS) inventory and
// compute coverage — all in-process (no worker). MYOB is paged over the
// existing AccountRight OAuth connection, so this can take ~10–120s for a large
// catalogue; the request stays open until done, then returns the updated row.
// Read-only against MYOB — nothing is written back. Gated on edit:b2b_catalogue.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../../lib/authServer'
import { loadJawsInventory, buildMatchAndCoverage } from '../../../../../../lib/jaws-stocktake'

export const config = { maxDuration: 300 }

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('edit:b2b_catalogue', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'Missing upload id' })

  const db = sb()
  const { data: row, error: loadErr } = await db
    .from('jaws_stocktake_uploads')
    .select('id, status, parsed_rows')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) return res.status(500).json({ error: loadErr.message })
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (row.status === 'matching') {
    return res.status(409).json({ error: 'A match is already running for this upload.' })
  }

  await db.from('jaws_stocktake_uploads').update({ status: 'matching', notes: null }).eq('id', id)

  try {
    const items = await loadJawsInventory(user.id)
    const { matchResults, matchedCount, unmatchedCount, coverage } =
      buildMatchAndCoverage(row.parsed_rows || [], items)

    const nowIso = new Date().toISOString()
    const { data: updated, error: upErr } = await db
      .from('jaws_stocktake_uploads')
      .update({
        status: 'matched',
        matched_at: nowIso,
        matched_count: matchedCount,
        unmatched_count: unmatchedCount,
        match_results: matchResults,
        coverage,
        coverage_at: nowIso,
        in_stock_total: coverage.total,
        in_stock_uncounted: coverage.uncounted_count,
        notes: null,
      })
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (upErr) throw new Error(upErr.message)

    return res.status(200).json(updated)
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 500)
    await db.from('jaws_stocktake_uploads').update({ status: 'failed', notes: msg }).eq('id', id)
    return res.status(500).json({ error: msg })
  }
})

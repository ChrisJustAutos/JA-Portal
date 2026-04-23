// pages/api/calls/[id]/analysis.ts
// Returns the coaching analysis for a call, or 404 if not yet analysed.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../../lib/auth'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' })
      }

      const { id } = req.query
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Missing call id' })
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })

      const sb = createClient(url, key, { auth: { persistSession: false } })

      // Latest analysis wins if, for some reason, there are multiple.
      const { data, error } = await sb
        .from('call_analysis')
        .select('id, rubric_version, outcome, outcome_confidence, sales_score, dimension_scores, observations, summary, model, cost_micro_usd, analysed_at')
        .eq('call_id', id)
        .order('analysed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'No analysis for this call' })

      return res.status(200).json({ analysis: data })
    } catch (e: any) {
      console.error('analysis error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

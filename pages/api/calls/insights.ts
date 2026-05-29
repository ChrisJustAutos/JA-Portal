// pages/api/calls/insights.ts
// Aggregate analytics behind the Calls page insight tabs (Sentiment, Coaching,
// Words & Objections, Conversion). Pure DB aggregation — no AI. The narrative
// summaries live in ./insights/summary.ts.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { makeServiceClient, fetchInsightDataset, buildInsights } from '../../../lib/calls-insights'

export const config = { maxDuration: 30 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

      const q = req.query
      const startDate = q.startDate ? String(q.startDate) : null
      const endDate = q.endDate ? String(q.endDate) : null
      const agent = q.agent ? String(q.agent) : null

      const sb = makeServiceClient()
      const { dataset, externalById, truncated } = await fetchInsightDataset(sb, { startDate, endDate, agent })
      const insights = buildInsights(dataset, externalById, { truncated, startDate, endDate })

      return res.status(200).json(insights)
    } catch (e: any) {
      console.error('insights error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

// pages/api/cron/crm-campaigns.ts
// Vercel cron — promotes scheduled campaigns and drains the send queue in
// batches via Resend. Auth: CRON_SECRET bearer (or vercel-cron UA).

import { NextApiRequest, NextApiResponse } from 'next'
import { processCampaigns } from '../../../lib/crm-campaigns'

export const config = { maxDuration: 120 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    const result = await processCampaigns(100)
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}

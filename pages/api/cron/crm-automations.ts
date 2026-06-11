// pages/api/cron/crm-automations.ts
// Vercel cron (5-min) — walks due CRM automation flows (graph engine).
// Auth: CRON_SECRET bearer (or the vercel-cron user-agent), like the other crons.

import { NextApiRequest, NextApiResponse } from 'next'
import { processDueAutomations } from '../../../lib/crm-automations'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    const result = await processDueAutomations(150)
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}

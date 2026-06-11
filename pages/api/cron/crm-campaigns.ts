// pages/api/cron/crm-campaigns.ts
// Vercel cron (5-min) — promotes scheduled campaigns and drains the send
// queue in batches via Resend, then runs the CRM call linkage (attach CDRs
// to click-to-dial calls + log recent calls onto contact timelines).
// Auth: CRON_SECRET bearer (or vercel-cron UA).

import { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { processCampaigns } from '../../../lib/crm-campaigns'
import { processCallLinkage } from '../../../lib/crm-call-link'

export const config = { maxDuration: 120 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  try {
    const result = await processCampaigns(100)
    let callLink: any = null
    try {
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
      callLink = await processCallLinkage(db)
    } catch (e: any) { callLink = { error: e?.message || String(e) } }
    return res.status(200).json({ ok: true, ...result, callLink })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
}

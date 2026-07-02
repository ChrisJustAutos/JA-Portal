// pages/api/cron/slack-cleanup.ts
// Vercel cron (every minute) — deletes parts-bot answers whose 5-min TTL has
// passed, to keep the channel clear. See lib/slack-bot/ephemeral.ts.
// Auth: CRON_SECRET bearer (same as the other crons).

import type { NextApiRequest, NextApiResponse } from 'next'
import { sweepDueDeletions } from '../../../lib/slack-bot/ephemeral'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const r = await sweepDueDeletions()
    return res.status(200).json({ ok: true, ...r })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 300) })
  }
}

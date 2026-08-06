// pages/api/cron/b2b-dropship-confirm.ts
// Every 15 min: scan orders@justautoswholesale.com for supplier confirmations
// of open drop-ship POs; on a confirmed match, run the full receiving flow
// (PO → Bill, sale order → invoice, payment receipt) automatically.
//
// Auth: Bearer CRON_SECRET, with the vercel-cron user-agent fallback.

import type { NextApiRequest, NextApiResponse } from 'next'
import { scanDropShipConfirmations } from '../../../lib/b2b-dropship-confirm-watch'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase()
  const authorized = cronSecret ? authHeader === `Bearer ${cronSecret}` : userAgent.includes('vercel-cron')
  if (!authorized) return res.status(401).json({ error: 'Unauthorised' })

  const lookbackDays = req.query.lookback ? Number(req.query.lookback) : undefined
  const result = await scanDropShipConfirmations({ lookbackDays })
  return res.status(200).json({ ok: result.errors.length === 0, ...result })
}

// pages/api/cron/ap-auto-entry.ts
//
// VPS automated invoice entry. Scans the VPS accounts inbox, fact-checks each
// invoice, posts the clean ones straight to MYOB (tax-inclusive, no portal row)
// and Slacks a breakdown; flags the rest in Slack and leaves the email. See
// lib/ap-auto-entry.ts.
//
// Gated by AP_AUTO_ENTRY_ENABLED (default false) — until that's 'true' a real
// run does nothing. ?dry=1 previews the fact-check + intended actions for every
// invoice WITHOUT posting, Slacking, staging, or writing dedup rows (works even
// when disabled, so you can preview before switching it on). ?sinceDays=N
// widens the lookback (default 7).
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron), or a logged-in
// staffer with view:supplier_invoices (so a manual preview needs no secret).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runAutoEntry } from '../../../lib/ap-auto-entry'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:supplier_invoices')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const dry = req.query.dry === '1'
  const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : undefined

  try {
    const outcome = await runAutoEntry({ dryRun: dry, sinceDays })
    const counts = outcome.processed.reduce((m: Record<string, number>, p) => { m[p.outcome] = (m[p.outcome] || 0) + 1; return m }, {})
    return res.status(200).json({ ok: true, ...outcome, counts })
  } catch (e: any) {
    console.error('[ap-auto-entry] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}

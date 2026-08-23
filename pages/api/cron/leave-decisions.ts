// pages/api/cron/leave-decisions.ts
//
// Every 15 minutes: read the monday "Payroll & Leave Applications" board and
// email the applicant for any application newly marked Approved or Denied
// (lib/leave-decision-emails). One row per item+decision in
// leave_decision_emails is the dedupe key, so a re-run emails nobody twice.
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runLeaveDecisionEmails } from '../../../lib/leave-decision-emails'

export const config = { maxDuration: 60 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const ok = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!ok) return res.status(401).json({ error: 'Unauthorized' })

  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  try {
    const r = await runLeaveDecisionEmails()
    return res.status(200).json({ ok: true, ...r })
  } catch (e: any) {
    console.error('[leave-decisions] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 300) })
  }
}

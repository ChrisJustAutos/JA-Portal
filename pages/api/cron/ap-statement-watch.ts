// pages/api/cron/ap-statement-watch.ts
//
// Hourly: scan the two accounts inboxes for supplier statements, reconcile each
// against its MYOB file (JAWS/VPS) via the existing statement engine, and EMAIL
// a digest of invoices that are on a statement but missing from MYOB. Report-only
// — never writes to MYOB. Dedupe (ap_statement_scans) means a statement is only
// ever processed/emailed once, so hourly runs are near-real-time but never spam:
// runs with no NEW statement do nothing (and don't email).
//
// Schedule (vercel.json): top of every hour. ?dry=1 returns the digest without
// emailing (and without recording dedupe rows, so a real run still processes
// those statements). ?sinceDays=N widens the lookback (default 4).
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this automatically).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runStatementWatch, buildDigestHtml } from '../../../lib/ap-statement-watch'
import { sendMail } from '../../../lib/email'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

function recipients(): string[] {
  const raw = (process.env.AP_STATEMENT_REPORT_TO || 'chris@justautosmechanical.com.au,jarred@justautosmechanical.com.au').trim()
  return raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: Vercel cron sends the CRON_SECRET bearer. Also allow a logged-in
  // staffer with AP access to trigger a manual check from the browser
  // (e.g. /api/cron/ap-statement-watch?dry=1&sinceDays=30).
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:supplier_invoices')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const dry = req.query.dry === '1'

  try {
    const sinceDays = req.query.sinceDays ? Number(req.query.sinceDays) : undefined
    const outcome = await runStatementWatch({ sinceDays, dryRun: dry })
    const digest = buildDigestHtml(outcome, new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }))

    if (!digest) {
      return res.status(200).json({ ok: true, emailed: false, note: 'No new statements found this run.', outcome })
    }
    if (dry) {
      return res.status(200).json({ ok: true, dryRun: true, subject: digest.subject, html: digest.html, outcome })
    }

    await sendMail('accounts@justautosmechanical.com.au', {
      to: recipients(),
      subject: digest.subject,
      html: digest.html,
    })
    return res.status(200).json({ ok: true, emailed: true, to: recipients(), subject: digest.subject, outcome })
  } catch (e: any) {
    console.error('[ap-statement-watch] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}

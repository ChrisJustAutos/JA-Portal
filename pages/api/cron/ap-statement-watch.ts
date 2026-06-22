// pages/api/cron/ap-statement-watch.ts
//
// Daily 7am Sydney: scan the two accounts inboxes for supplier statements,
// reconcile each against its MYOB file (JAWS/VPS) via the existing statement
// engine, and EMAIL a digest of invoices that are on a statement but missing
// from MYOB. Report-only — never writes to MYOB.
//
// Schedule (vercel.json): 20:00 + 21:00 UTC; the handler gates on Sydney local
// hour == 7 so it lands at 7am year-round (DST-safe). ?force=1 bypasses the
// gate; ?dry=1 returns the digest without emailing (and without recording the
// dedupe rows, so a real run still processes those statements).
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron sends this automatically).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runStatementWatch, buildDigestHtml } from '../../../lib/ap-statement-watch'
import { sendMail } from '../../../lib/email'

function sydneyHour(d: Date): number {
  const h = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }).format(d)
  return parseInt(h, 10)
}

function recipients(): string[] {
  const raw = (process.env.AP_STATEMENT_REPORT_TO || 'chris@justautosmechanical.com.au').trim()
  return raw.split(/[,;]+/).map(s => s.trim()).filter(Boolean)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const force = req.query.force === '1'
  const dry = req.query.dry === '1'
  if (!force && sydneyHour(new Date()) !== 7) {
    return res.status(200).json({ ok: true, skipped: 'not 7am Sydney (pass ?force=1 to run now)' })
  }

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

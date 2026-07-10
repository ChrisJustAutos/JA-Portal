// pages/api/cron/calls-analyse.ts
//
// Portal-side call coaching analysis sweep (see lib/calls-analysis.ts).
// Every 5 minutes: claim requested analysis_jobs + pick up freshly transcribed
// calls (≥60s) with no analysis, classify each call's TYPE, score it against
// that type's rubric dimensions, write call_analysis + the mirror columns, and
// apply transcript-based advisor attribution.
//
// Gated by CALLS_ANALYSIS_ENABLED (default false) — leave OFF until the
// FreePBX worker's analysis loop is disabled, or both will double-analyse.
//
// Query params (work even while disabled — nothing is written on dry runs):
//   ?dry=1              analyse WITHOUT writing anything; returns the parsed output
//   ?call_id=<uuid>     analyse just this call (combine with dry=1 to preview)
//   ?rubric=<version>   use a specific rubric version instead of the active one
//   ?limit=N            max calls this run (default 8, max 20)
//
// Auth: Authorization: Bearer $CRON_SECRET (Vercel cron), or a logged-in
// staffer with view:calls (so previews need no secret).

import type { NextApiRequest, NextApiResponse } from 'next'
import { runAnalysisSweep, analyseCall, callsAnalysisEnabled } from '../../../lib/calls-analysis'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:calls')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const dry = req.query.dry === '1'
  const rubricVersion = typeof req.query.rubric === 'string' ? req.query.rubric : null
  const callId = typeof req.query.call_id === 'string' ? req.query.call_id : null
  const limit = req.query.limit ? Number(req.query.limit) : undefined

  try {
    if (callId) {
      const result = await analyseCall(callId, { dryRun: dry, rubricVersion })
      return res.status(200).json({ ok: true, enabled: callsAnalysisEnabled(), dryRun: dry, result })
    }
    const outcome = await runAnalysisSweep({ dryRun: dry, limit, rubricVersion })

    // Negative-call automation (lib/call-concerns): flag complaint/concern/
    // support calls into Slack, then chase un-actioned ones. Failures here
    // must never break the coaching sweep.
    let concerns: any = null
    let followups: any = null
    try {
      const { runConcernSweep, runConcernFollowups } = await import('../../../lib/call-concerns')
      concerns = await runConcernSweep({ dryRun: dry, limit })
      if (!dry) followups = await runConcernFollowups()
    } catch (e: any) {
      concerns = { error: (e?.message || String(e)).slice(0, 300) }
      console.error('[calls-analyse] concern sweep failed:', e?.message || e)
    }

    return res.status(200).json({ ok: true, ...outcome, concerns, followups })
  } catch (e: any) {
    console.error('[calls-analyse] failed:', e?.message || e)
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}

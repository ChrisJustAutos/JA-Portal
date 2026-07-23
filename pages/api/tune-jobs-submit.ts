// pages/api/tune-jobs-submit.ts
// Submission endpoint for the login-less /tune-jobs fill page. Auth = the
// signed tune_jobs token from the reminder email (scoped to one distributor);
// submitTuneJobDetails re-checks the job belongs to that distributor.

import type { NextApiRequest, NextApiResponse } from 'next'
import { verifyOrderAction } from '../../lib/order-action-token'
import { submitTuneJobDetails, TuneJobDetails } from '../../lib/b2b-tune-jobs'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const v = verifyOrderAction(String(body.token || ''), 'tune_jobs')
  if (!v) return res.status(401).json({ error: 'This link has expired — use the newest reminder email.' })
  const jobId = String(body.job_id || '').trim()
  if (!jobId) return res.status(400).json({ error: 'job_id required' })
  try {
    await submitTuneJobDetails(jobId, v.orderId /* distributor id */, null, (body.details || {}) as TuneJobDetails)
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Submit failed' })
  }
}

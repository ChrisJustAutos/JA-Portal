// pages/api/ap/jobs/search.ts
// Search workshop jobs for the manual job picker on the AP detail page.
// GET /api/ap/jobs/search?q=hilux&limit=25
//
// Backed by the public.job_report_jobs_latest view which is one row per
// job_number (most recent ingest snapshot). Auto-pull refreshes this every
// 2 hours during work hours via the GH Actions cron.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { searchJobs } from '../../../../lib/ap-job-link'

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const q = String(req.query.q || '').trim()
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '25'), 10), 1), 100)
  const jobs = await searchJobs(q, limit)
  return res.status(200).json({ jobs, query: q })
})

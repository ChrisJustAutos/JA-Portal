// pages/api/ap/admin/backfill-contact.ts
//
// Portal-session admin endpoint to run the contact-fields backfill.
// Same job is also exposed via Bearer auth on /api/ap/admin/automation
// (action='backfill_contact') — prefer that for cron / mobile use.
//
//   GET  /api/ap/admin/backfill-contact            → preview eligible rows
//   POST /api/ap/admin/backfill-contact?limit=25   → run backfill (default 25, max 100)
//
// Eligibility lives in lib/ap-backfill-contact.ts. Only the 8 new vendor
// contact columns are written; lines/totals/triage/supplier mapping are
// untouched.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { fetchBackfillEligible, runContactBackfill } from '../../../../lib/ap-backfill-contact'

export const config = { maxDuration: 300 }

export default withAuth('admin:settings', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    const eligible = await fetchBackfillEligible(200)
    return res.status(200).json({ count: eligible.length, sample: eligible.slice(0, 10) })
  }

  if (req.method === 'POST') {
    const limit = parseInt(String(req.query.limit || '25'), 10) || 25
    const result = await runContactBackfill({ limit })
    return res.status(200).json(result)
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
})

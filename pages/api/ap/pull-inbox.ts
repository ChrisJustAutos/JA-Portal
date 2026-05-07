// pages/api/ap/pull-inbox.ts
// Bulk-ingest unprocessed invoices from a shared mailbox via Microsoft Graph.
// Portal-session endpoint (edit:supplier_invoices).
//
// All real work lives in lib/ap-inbox-pull.ts so the bearer-auth automation
// endpoint can run the same pipeline without going through portal auth.
//
// POST /api/ap/pull-inbox  { sinceDays?: number }  default 30, max 90

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { runInboxPull } from '../../../lib/ap-inbox-pull'

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
  maxDuration: 300,
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { sinceDays } = (req.body || {}) as { sinceDays?: number }
  const result = await runInboxPull({ sinceDays })

  if (!result.ok) {
    const { status, ...payload } = result
    return res.status(status).json(payload)
  }
  return res.status(200).json(result)
})

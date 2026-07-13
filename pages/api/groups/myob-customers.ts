// pages/api/groups/myob-customers.ts
// Returns a distinct list of MYOB customer names seen on JAWS invoices.
// Used by the admin UI to surface "unclassified" customer cards.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { fetchCustomerNames } from '../../../lib/myob-reporting'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      // Direct MYOB OAuth (CData decommissioned 2026-07-14) — customer card
      // names from the JAWS company file.
      const names = await fetchCustomerNames('JAWS')
      res.status(200).json({ customers: names, count: names.length })
    } catch (e: any) {
      console.error('myob-customers error:', e)
      res.status(500).json({ error: e.message || 'Failed to load MYOB customers' })
    }
  })
}

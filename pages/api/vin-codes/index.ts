// pages/api/vin-codes/index.ts
// GET: return full VIN rules snapshot

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { getVinRules, invalidateVinCache } from '../../../lib/vinCodes'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const force = req.query.refresh === 'true'
      if (force) invalidateVinCache()
      const snapshot = await getVinRules(force)
      res.status(200).json({ rules: snapshot.rules, fetchedAt: snapshot.fetchedAt })
    } catch (e: any) {
      console.error('vin-codes GET error:', e)
      res.status(500).json({ error: e.message || 'Failed to load VIN rules' })
    }
  })
}

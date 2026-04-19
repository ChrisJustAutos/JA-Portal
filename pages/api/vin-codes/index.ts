// pages/api/vin-codes/index.ts
// GET: return full VIN rules snapshot

import type { NextApiRequest, NextApiResponse } from 'next'
import { getVinRules, invalidateVinCache } from '../../../lib/vinCodes'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cookie = req.cookies['ja_portal_auth']
  const pw = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (!cookie) return res.status(401).json({ error: 'Unauthenticated' })
  try {
    if (Buffer.from(cookie, 'base64').toString('utf8') !== pw) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }
  } catch { return res.status(401).json({ error: 'Unauthenticated' }) }

  try {
    const force = req.query.refresh === 'true'
    if (force) invalidateVinCache()
    const snapshot = await getVinRules(force)
    res.status(200).json({ rules: snapshot.rules, fetchedAt: snapshot.fetchedAt })
  } catch (e: any) {
    console.error('vin-codes GET error:', e)
    res.status(500).json({ error: e.message || 'Failed to load VIN rules' })
  }
}

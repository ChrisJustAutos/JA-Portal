// pages/api/groups/index.ts
// GET: return full grouping snapshot (aliases, groups, members)
// Used by both the admin UI and the distributors page.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getGrouping, invalidateGroupingCache } from '../../../lib/distGroups'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Simple auth — same portal cookie check as other routes
  const cookie = req.cookies['ja_portal_auth']
  const pw = process.env.PORTAL_PASSWORD || 'justautos2026'
  if (!cookie) return res.status(401).json({ error: 'Unauthenticated' })
  try {
    if (Buffer.from(cookie, 'base64').toString('utf8') !== pw) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }
  } catch {
    return res.status(401).json({ error: 'Unauthenticated' })
  }

  try {
    const force = req.query.refresh === 'true'
    if (force) invalidateGroupingCache()
    const snapshot = await getGrouping(force)
    res.status(200).json({
      aliases: snapshot.aliases,
      groups: snapshot.groups,
      members: snapshot.members,
      fetchedAt: snapshot.fetchedAt,
    })
  } catch (e: any) {
    console.error('groups API error:', e)
    res.status(500).json({ error: e.message || 'Failed to load grouping' })
  }
}

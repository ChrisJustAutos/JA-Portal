// pages/api/projects/[itemId]/updates.ts
// GET  → the full comment thread (Monday "updates") for one project item.
// POST → post a new comment back to the Monday item ({ body }).
//
// Reads gate on view:projects; posting additionally requires edit:projects.
// Posting reuses createUpdate() from lib/monday-update.ts (the same helper the
// quote pipeline uses) so there's one create-update implementation.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth, PortalUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { fetchItemUpdates } from '../../../../lib/monday-projects'
import { createUpdate } from '../../../../lib/monday-update'
import { invalidateProjectsCache } from '../index'

export const config = { maxDuration: 20 }

export default withAuth('view:projects', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  if (!process.env.MONDAY_API_TOKEN) {
    return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
  }

  const itemId = String(req.query.itemId || '').trim()
  if (!itemId || !/^\d+$/.test(itemId)) {
    return res.status(400).json({ error: 'Invalid item id' })
  }

  if (req.method === 'GET') {
    try {
      const updates = await fetchItemUpdates(itemId)
      return res.status(200).json({ updates })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Failed to load comments' })
    }
  }

  if (req.method === 'POST') {
    if (!roleHasPermission(user.role, 'edit:projects')) {
      return res.status(403).json({ error: 'Forbidden — cannot post comments' })
    }
    const body = String(req.body?.body || '').trim()
    if (!body) return res.status(400).json({ error: 'Comment body required' })
    if (body.length > 5000) return res.status(400).json({ error: 'Comment too long (max 5000 chars)' })

    try {
      await createUpdate(itemId, body)
      invalidateProjectsCache()  // hasUpdates may have flipped on this item
      // Re-read the thread so the client gets the canonical list (incl. the new
      // comment with its real id/timestamp).
      const updates = await fetchItemUpdates(itemId)
      return res.status(201).json({ ok: true, updates })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'Failed to post comment' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

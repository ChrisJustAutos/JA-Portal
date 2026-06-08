// pages/api/projects/[itemId]/subitems.ts
// POST → create a subitem under a project. Body: { name:string }.
// Returns the new subitem (same shape as the list payload).

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth, PortalUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createSubitem } from '../../../../lib/monday-projects'
import { invalidateProjectsCache } from '../index'

export const config = { maxDuration: 15 }

export default withAuth('view:projects', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not configured' })
  if (!roleHasPermission(user.role, 'edit:projects')) return res.status(403).json({ error: 'Forbidden' })

  const itemId = String(req.query.itemId || '').trim()
  if (!/^\d+$/.test(itemId)) return res.status(400).json({ error: 'Invalid item id' })

  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Subitem name required' })
  if (name.length > 255) return res.status(400).json({ error: 'Name too long' })

  try {
    const subitem = await createSubitem(itemId, name)
    invalidateProjectsCache()
    return res.status(201).json({ ok: true, subitem })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to create subitem' })
  }
})

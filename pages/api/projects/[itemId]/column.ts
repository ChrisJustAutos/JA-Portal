// pages/api/projects/[itemId]/column.ts
// POST → set a status/label column on a project OR subitem, by label text.
// Body: { boardId:number, columnId:string, label:string }
// Used for the status dropdowns in the /projects inspector.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth, PortalUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { setStatusLabel } from '../../../../lib/monday-projects'
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

  const boardId = Number(req.body?.boardId)
  const columnId = String(req.body?.columnId || '').trim()
  const label = String(req.body?.label ?? '').trim()
  if (!boardId || !columnId) return res.status(400).json({ error: 'boardId and columnId required' })
  if (!label) return res.status(400).json({ error: 'label required' })

  try {
    await setStatusLabel(itemId, boardId, columnId, label)
    invalidateProjectsCache()
    return res.status(200).json({ ok: true })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to update column' })
  }
})

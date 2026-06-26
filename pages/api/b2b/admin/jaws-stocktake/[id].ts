// pages/api/b2b/admin/jaws-stocktake/[id].ts
//
// GET:    read upload state (view:b2b)
// PATCH:  complete / reopen the stocktake (edit:b2b_catalogue). Body
//         { action: 'complete' | 'reopen' } flips status matched ↔ completed.
// DELETE: delete the upload row (edit:b2b_catalogue). DB only — nothing in MYOB
//         is touched (this feature never writes to MYOB).
//         Pass ?force=1 to delete a row stuck in 'matching' for > 5 minutes.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'

const STUCK_THRESHOLD_MIN = 5

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'Missing upload id' })

  if (req.method === 'GET') return handleGet(req, res, id)
  if (req.method === 'PATCH') return handlePatch(req, res, id)
  if (req.method === 'DELETE') return handleDelete(req, res, id)
  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
}

async function handleGet(req: NextApiRequest, res: NextApiResponse, id: string) {
  const user = await getCurrentUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  if (!roleHasPermission(user.role, 'view:b2b')) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  const { data, error } = await sb()
    .from('jaws_stocktake_uploads')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Not found' })
  return res.status(200).json(data)
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const user = await getCurrentUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  if (!roleHasPermission(user.role, 'edit:b2b_catalogue')) {
    return res.status(403).json({ error: 'Forbidden — manager or admin only' })
  }

  const action = (req.body || {}).action
  if (action !== 'complete' && action !== 'reopen') {
    return res.status(400).json({ error: "Body must be { action: 'complete' | 'reopen' }" })
  }

  const { data: row, error: loadErr } = await sb()
    .from('jaws_stocktake_uploads')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (loadErr) return res.status(500).json({ error: loadErr.message })
  if (!row) return res.status(404).json({ error: 'Not found' })

  if (action === 'complete' && row.status !== 'matched' && row.status !== 'completed') {
    return res.status(409).json({ error: 'Run match and review the results before marking this complete.' })
  }
  if (action === 'reopen' && row.status !== 'completed') {
    return res.status(409).json({ error: 'Only a completed stocktake can be reopened.' })
  }

  const patch = action === 'complete'
    ? { status: 'completed', completed_at: new Date().toISOString(), completed_by: user.id }
    : { status: 'matched', completed_at: null, completed_by: null }

  const { data: updated, error } = await sb()
    .from('jaws_stocktake_uploads')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json(updated)
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const user = await getCurrentUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  if (!roleHasPermission(user.role, 'edit:b2b_catalogue')) {
    return res.status(403).json({ error: 'Forbidden — manager or admin only' })
  }

  const existing = await sb()
    .from('jaws_stocktake_uploads')
    .select('id, status, filename, uploaded_at')
    .eq('id', id)
    .maybeSingle()
  if (existing.error) return res.status(500).json({ error: existing.error.message })
  if (!existing.data) return res.status(404).json({ error: 'Not found' })

  const row = existing.data
  const force = req.query.force === '1' || req.query.force === 'true'

  if (row.status === 'matching') {
    if (!force) {
      return res.status(409).json({
        error: `Cannot delete while matching — wait for it to finish or fail. If genuinely stuck, retry after ${STUCK_THRESHOLD_MIN} minutes.`,
      })
    }
    const anchor = new Date(row.uploaded_at as string).getTime()
    if (!isFinite(anchor)) {
      return res.status(500).json({ error: 'Could not determine when matching started' })
    }
    const ageMin = (Date.now() - anchor) / 60_000
    if (ageMin < STUCK_THRESHOLD_MIN) {
      return res.status(409).json({
        error: `Row has only been matching for ${ageMin.toFixed(1)} min. Force-delete requires > ${STUCK_THRESHOLD_MIN} min.`,
      })
    }
  }

  const { error } = await sb()
    .from('jaws_stocktake_uploads')
    .delete()
    .eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ ok: true, deleted_id: id, deleted_filename: row.filename })
}

// pages/api/stocktake/[id].ts
//
// GET:    read upload state (admin/manager users OR service token)
// PATCH:  update fields (service token only — used by GH Action worker)
// DELETE: delete the upload row (admin/manager users only) — DB only,
//         does NOT touch Mechanics Desk

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { validateServiceToken } from '../../../lib/service-auth'

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
  // Allow either user session (with view:stocktakes) or service token
  const user = await getCurrentUser(req)
  if (user) {
    if (!roleHasPermission(user.role, 'view:stocktakes')) {
      return res.status(403).json({ error: 'Forbidden' })
    }
  } else {
    const svc = await validateServiceToken(req, 'stocktake:write')
    if (!svc) return res.status(401).json({ error: 'Unauthorised' })
  }

  const { data, error } = await sb()
    .from('stocktake_uploads')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Not found' })
  return res.status(200).json(data)
}

async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Unauthorised — service token required' })

  const allowed: Record<string, true> = {
    status: true,
    matched_at: true,
    matched_count: true,
    unmatched_count: true,
    match_results: true,
    push_started_at: true,
    push_completed_at: true,
    pushed_count: true,
    push_errors: true,
    github_run_id: true,
    mechanicdesk_stocktake_id: true,
    mechanicdesk_sheet_id: true,
    mechanicdesk_stocktake_was_created: true,
    notes: true,
  }
  const update: Record<string, any> = {}
  for (const [k, v] of Object.entries(req.body || {})) {
    if (allowed[k]) update[k] = v
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No allowed fields in request body' })
  }

  const { data, error } = await sb()
    .from('stocktake_uploads')
    .update(update)
    .eq('id', id)
    .select('id, status')
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Not found' })
  return res.status(200).json({ ok: true, upload_id: data.id, status: data.status })
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  // User-only — never service token. Deletion is a human action.
  const user = await getCurrentUser(req)
  if (!user) return res.status(401).json({ error: 'Unauthorised' })
  if (!roleHasPermission(user.role, 'edit:stocktakes')) {
    return res.status(403).json({ error: 'Forbidden — manager or admin only' })
  }

  // Refuse to delete a row that's actively running. The GH Action worker
  // would silently fail on its next PATCH and leave the user wondering.
  const existing = await sb()
    .from('stocktake_uploads')
    .select('id, status, filename')
    .eq('id', id)
    .maybeSingle()
  if (existing.error) return res.status(500).json({ error: existing.error.message })
  if (!existing.data) return res.status(404).json({ error: 'Not found' })

  if (existing.data.status === 'matching' || existing.data.status === 'pushing') {
    return res.status(409).json({
      error: `Cannot delete while ${existing.data.status} — wait for the GitHub Action to finish or fail first.`,
    })
  }

  const { error } = await sb()
    .from('stocktake_uploads')
    .delete()
    .eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({
    ok: true,
    deleted_id: id,
    deleted_filename: existing.data.filename,
    note: 'Portal record removed. Mechanics Desk stocktake (if any) was NOT touched — delete it manually in MD if needed.',
  })
}

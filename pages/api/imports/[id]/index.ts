// pages/api/imports/[id]/index.ts
// GET    — fetch a single import (no parsed_data — that's heavy)
// DELETE — remove an import record (admin), only when not running

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('md_imports')
      .select('id, type, filename, uploaded_at, uploaded_by, status, parsed_summary, result_summary, error, started_at, completed_at')
      .eq('id', id).maybeSingle()
    if (error || !data) return res.status(404).json({ error: 'Import not found' })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { data: row } = await db.from('md_imports').select('status').eq('id', id).maybeSingle()
    if (!row) return res.status(404).json({ error: 'Import not found' })
    if ((row as any).status === 'running') return res.status(409).json({ error: 'Cannot delete a running import' })
    const { error } = await db.from('md_imports').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'GET or DELETE only' })
})

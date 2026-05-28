// pages/api/imports/index.ts
//   GET  — list recent imports (admin)
//   POST { type, filename } — creates an import row in 'uploading'. Chunks
//        get streamed to /[id]/chunk afterwards (per role). Then /finalize.
//
// (Previous shape baked the first chunk into this endpoint — moved out so
// multi-role imports can stream chunks for each role separately.)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { IMPORTER_TYPES } from '../../../lib/md-importers'

export const config = { maxDuration: 30 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const db = sb()

  if (req.method === 'GET') {
    const { data, error } = await db.from('md_imports')
      .select('id, type, filename, uploaded_at, uploaded_by, status, parsed_summary, result_summary, error, started_at, completed_at')
      .order('uploaded_at', { ascending: false })
      .limit(50)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ imports: data || [] })
  }

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }

    const type = String(body.type || '')
    if (!IMPORTER_TYPES.includes(type as any)) return res.status(400).json({ error: `Unsupported type. Use one of: ${IMPORTER_TYPES.join(', ')}` })
    const filename = String(body.filename || 'upload.xls').slice(0, 200)

    const { data, error } = await db.from('md_imports').insert({
      type, filename, uploaded_by: user.id, status: 'uploading',
    }).select('id').single()
    if (error) return res.status(500).json({ error: error.message })

    return res.status(201).json({ id: data!.id })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

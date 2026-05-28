// pages/api/imports/[id]/chunk.ts
// POST { chunk_index, rows } — appends another chunk of mapped rows to an
// in-progress upload (status must be 'uploading').

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '4mb' } } }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const chunkIndex = Number(body.chunk_index)
  const rows = Array.isArray(body.rows) ? body.rows : null
  if (!isFinite(chunkIndex) || chunkIndex < 1) return res.status(400).json({ error: 'chunk_index (>=1) required' })
  if (!rows) return res.status(400).json({ error: 'rows (array) required' })

  const db = sb()
  const { data: imp } = await db.from('md_imports').select('status').eq('id', id).maybeSingle()
  if (!imp) return res.status(404).json({ error: 'Import not found' })
  if ((imp as any).status !== 'uploading') return res.status(409).json({ error: `Import is ${(imp as any).status}, not accepting more chunks` })

  const { error } = await db.from('md_import_chunks').insert({ import_id: id, chunk_index: chunkIndex, rows })
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ ok: true })
})

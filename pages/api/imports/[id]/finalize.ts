// pages/api/imports/[id]/finalize.ts
// POST — reads all chunks, concatenates them, runs the type's normalize(),
// stores parsed_data + parsed_summary on the import row, flips status to
// 'parsed', deletes the now-redundant chunk rows. Client polls this after
// uploading the last chunk.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getImporter } from '../../../../lib/md-importers'

export const config = { maxDuration: 120 }

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

  const db = sb()
  const { data: imp } = await db.from('md_imports').select('id, type, status').eq('id', id).maybeSingle()
  if (!imp) return res.status(404).json({ error: 'Import not found' })
  if ((imp as any).status !== 'uploading') return res.status(409).json({ error: `Import is ${(imp as any).status}, already finalized` })

  const importer = getImporter((imp as any).type)
  if (!importer) return res.status(500).json({ error: 'No importer registered' })

  // Pull all chunks in order. Even huge imports come in as ~20 chunks so this
  // is one query of jsonb rows.
  const allRows: any[] = []
  for (let from = 0; ; from += 100) {
    const { data, error } = await db.from('md_import_chunks')
      .select('chunk_index, rows')
      .eq('import_id', id)
      .order('chunk_index', { ascending: true })
      .range(from, from + 99)
    if (error) return res.status(500).json({ error: 'chunks read: ' + error.message })
    if (!data || data.length === 0) break
    for (const c of data) for (const r of (c as any).rows || []) allRows.push(r)
    if (data.length < 100) break
  }

  if (allRows.length === 0) return res.status(400).json({ error: 'No rows uploaded' })

  let normalized: any[], summary: any
  try {
    const r = importer.normalize(allRows)
    normalized = r.rows; summary = r.summary
  } catch (e: any) {
    return res.status(500).json({ error: 'Normalise failed: ' + (e?.message || e) })
  }

  const { error: updErr } = await db.from('md_imports').update({
    status: 'parsed', parsed_summary: summary, parsed_data: normalized,
  }).eq('id', id)
  if (updErr) return res.status(500).json({ error: updErr.message })

  // Free the chunks — they've been consumed.
  try { await db.from('md_import_chunks').delete().eq('import_id', id) } catch { /* best-effort cleanup */ }

  return res.status(200).json({ id, parsed_summary: summary })
})

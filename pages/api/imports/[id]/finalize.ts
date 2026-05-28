// pages/api/imports/[id]/finalize.ts
// POST — closes off an upload after all chunks have arrived.
//
// Streams the chunks back one at a time (a paged single-row SELECT — keeps each
// individual query tiny, avoids the per-statement timeout you'd hit reading all
// ~10MB at once), concatenates them in memory, runs the type's normalize() to
// compute the preview summary, and stamps status='parsed' + parsed_summary on
// md_imports. The actual rows STAY in md_import_chunks until run completes —
// writing the whole array back as parsed_data on md_imports was what was
// timing out previously.

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

  const allRows: any[] = []
  let chunkIdx = 0
  while (true) {
    const { data, error } = await db.from('md_import_chunks')
      .select('chunk_index, rows')
      .eq('import_id', id)
      .order('chunk_index', { ascending: true })
      .range(chunkIdx, chunkIdx)
    if (error) return res.status(500).json({ error: `chunk ${chunkIdx} read: ${error.message}` })
    if (!data || data.length === 0) break
    for (const r of (data[0] as any).rows || []) allRows.push(r)
    chunkIdx++
  }

  if (allRows.length === 0) return res.status(400).json({ error: 'No rows uploaded' })

  let summary: any
  try { summary = importer.normalize(allRows).summary }
  catch (e: any) { return res.status(500).json({ error: 'Normalise failed: ' + (e?.message || e) }) }

  const { error: updErr } = await db.from('md_imports')
    .update({ status: 'parsed', parsed_summary: summary })
    .eq('id', id)
  if (updErr) return res.status(500).json({ error: updErr.message })

  // Chunks intentionally NOT deleted here — run() reads them again and only
  // cleans up on success.
  return res.status(200).json({ id, parsed_summary: summary })
})

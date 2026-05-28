// pages/api/imports/[id]/run.ts
// POST — execute the import via the type's runner. Reads rows back from
// md_import_chunks (one query per chunk, to keep statements small enough to
// stay inside the Supabase per-statement timeout), normalises in memory, then
// hands the full set to the type's run(). Chunks are deleted on success.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { getImporter } from '../../../../lib/md-importers'

export const config = { maxDuration: 300 }

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
  const { data: row, error: loadErr } = await db.from('md_imports')
    .select('id, type, status')
    .eq('id', id).maybeSingle()
  if (loadErr || !row) return res.status(404).json({ error: 'Import not found' })
  if ((row as any).status === 'running') return res.status(409).json({ error: 'Already running' })
  if ((row as any).status === 'completed') return res.status(409).json({ error: 'Already completed — upload again to re-run.' })
  if ((row as any).status !== 'parsed') return res.status(409).json({ error: `Import is ${(row as any).status} — finalise it first.` })

  await db.from('md_imports').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', id)

  try {
    const importer = getImporter((row as any).type)
    if (!importer) throw new Error(`No importer registered for "${(row as any).type}"`)

    // Stream chunks one at a time to keep each SELECT well under the timeout.
    const allRows: any[] = []
    let chunkIdx = 0
    while (true) {
      const { data, error } = await db.from('md_import_chunks')
        .select('chunk_index, rows')
        .eq('import_id', id)
        .order('chunk_index', { ascending: true })
        .range(chunkIdx, chunkIdx)
      if (error) throw new Error(`chunk ${chunkIdx} read: ${error.message}`)
      if (!data || data.length === 0) break
      for (const r of (data[0] as any).rows || []) allRows.push(r)
      chunkIdx++
    }
    if (allRows.length === 0) throw new Error('No rows in chunks — re-upload the file.')

    // Re-normalise (cheap, in-memory) and run.
    const normalized = importer.normalize(allRows).rows
    const summary = await importer.run(db, normalized)

    await db.from('md_imports').update({
      status: 'completed',
      result_summary: summary,
      completed_at: new Date().toISOString(),
    }).eq('id', id)

    // Free the staged rows now that they've been applied.
    try { await db.from('md_import_chunks').delete().eq('import_id', id) } catch { /* best-effort */ }

    return res.status(200).json({ ok: true, result_summary: summary })
  } catch (e: any) {
    await db.from('md_imports').update({
      status: 'failed',
      error: String(e?.message || e).substring(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('id', id)
    return res.status(500).json({ error: e?.message || 'Import failed' })
  }
})

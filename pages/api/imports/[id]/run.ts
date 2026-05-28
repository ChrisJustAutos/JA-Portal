// pages/api/imports/[id]/run.ts
// POST — runs the import. Streams chunks back grouped by role (same pattern
// as finalize, one chunk per SELECT to dodge the statement timeout) and
// hands the full per-role set to the type's run(). Chunks deleted on success.

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

async function streamRows(db: SupabaseClient, importId: string): Promise<Record<string, any[]>> {
  const roleSet = new Set<string>()
  {
    const { data } = await db.from('md_import_chunks').select('role').eq('import_id', importId).limit(10000)
    for (const r of data || []) roleSet.add((r as any).role)
  }
  const data: Record<string, any[]> = {}
  for (const role of Array.from(roleSet)) {
    data[role] = []
    let i = 0
    while (true) {
      const { data: chunks, error } = await db.from('md_import_chunks')
        .select('chunk_index, rows')
        .eq('import_id', importId).eq('role', role)
        .order('chunk_index', { ascending: true })
        .range(i, i)
      if (error) throw new Error(`role ${role} chunk ${i}: ${error.message}`)
      if (!chunks || chunks.length === 0) break
      for (const r of (chunks[0] as any).rows || []) data[role].push(r)
      i++
    }
  }
  return data
}

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })

  const db = sb()
  const { data: row, error: loadErr } = await db.from('md_imports').select('id, type, status').eq('id', id).maybeSingle()
  if (loadErr || !row) return res.status(404).json({ error: 'Import not found' })
  if ((row as any).status === 'running') return res.status(409).json({ error: 'Already running' })
  if ((row as any).status === 'completed') return res.status(409).json({ error: 'Already completed — upload again to re-run.' })
  if ((row as any).status !== 'parsed') return res.status(409).json({ error: `Import is ${(row as any).status} — finalise it first.` })

  await db.from('md_imports').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', id)

  try {
    const importer = getImporter((row as any).type)
    if (!importer) throw new Error(`No importer registered for "${(row as any).type}"`)

    const rolesData = await streamRows(db, id)
    const totalRows = Object.values(rolesData).reduce((a, b) => a + b.length, 0)
    if (totalRows === 0) throw new Error('No rows in chunks — re-upload the file.')

    const normalized = importer.normalize(rolesData).rows
    const summary = await importer.run(db, normalized)

    await db.from('md_imports').update({
      status: 'completed',
      result_summary: summary,
      completed_at: new Date().toISOString(),
    }).eq('id', id)

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

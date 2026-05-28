// pages/api/imports/[id]/finalize.ts
// Streams chunks back grouped by role (one chunk per SELECT to stay under the
// statement timeout), passes the per-role rows to the type's normalize(),
// and stamps status='parsed' + parsed_summary on md_imports. Chunks stay
// around for the subsequent run.

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

async function streamRows(db: SupabaseClient, importId: string): Promise<Record<string, any[]>> {
  // Pull distinct roles first; then stream one chunk at a time per role.
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
  const { data: imp } = await db.from('md_imports').select('id, type, status').eq('id', id).maybeSingle()
  if (!imp) return res.status(404).json({ error: 'Import not found' })
  if ((imp as any).status !== 'uploading') return res.status(409).json({ error: `Import is ${(imp as any).status}, already finalised` })

  const importer = getImporter((imp as any).type)
  if (!importer) return res.status(500).json({ error: 'No importer registered' })

  let rolesData: Record<string, any[]>
  try { rolesData = await streamRows(db, id) }
  catch (e: any) { return res.status(500).json({ error: e?.message || 'Failed to stream chunks' }) }

  const totalRows = Object.values(rolesData).reduce((a, b) => a + b.length, 0)
  if (totalRows === 0) return res.status(400).json({ error: 'No rows uploaded' })

  let summary: any
  try { summary = importer.normalize(rolesData).summary }
  catch (e: any) { return res.status(500).json({ error: 'Normalise failed: ' + (e?.message || e) }) }

  const { error: updErr } = await db.from('md_imports')
    .update({ status: 'parsed', parsed_summary: summary })
    .eq('id', id)
  if (updErr) return res.status(500).json({ error: updErr.message })

  return res.status(200).json({ id, parsed_summary: summary })
})

// pages/api/imports/[id]/run.ts
// POST — execute the import (reads parsed_data, calls the type's importer,
// writes result_summary). Runs synchronously inside the Vercel function.
// Vercel functions allow up to 300s execution — the customer importer batches
// in chunks of 500 so even 38k+ rows complete in a few seconds.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { runCustomersImport, MdCustomerRow } from '../../../../lib/md-importers/customers'

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
    .select('id, type, status, parsed_data')
    .eq('id', id).maybeSingle()
  if (loadErr || !row) return res.status(404).json({ error: 'Import not found' })
  if ((row as any).status === 'running') return res.status(409).json({ error: 'Already running' })
  if ((row as any).status === 'completed') return res.status(409).json({ error: 'Already completed — upload again to re-run.' })

  // Flag running so concurrent clicks bail.
  await db.from('md_imports').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', id)

  try {
    const parsedData = (row as any).parsed_data as any[]
    if (!Array.isArray(parsedData) || parsedData.length === 0) {
      throw new Error('No parsed data on this import — re-upload the file.')
    }

    let summary: any
    if ((row as any).type === 'customers') {
      summary = await runCustomersImport(db, parsedData as MdCustomerRow[])
    } else {
      throw new Error(`Importer for "${(row as any).type}" not implemented yet.`)
    }

    // Clear parsed_data to keep the table small; we don't need it after a successful run.
    await db.from('md_imports').update({
      status: 'completed',
      result_summary: summary,
      completed_at: new Date().toISOString(),
      parsed_data: null,
    }).eq('id', id)

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

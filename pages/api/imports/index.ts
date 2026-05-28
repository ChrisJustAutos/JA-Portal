// pages/api/imports/index.ts
// MD imports — list + create (parse) endpoints.
//   GET   — list recent imports (admin)
//   POST  — { type, filename, raw_rows: any[] } → parse + store as 'parsed'
//
// Client parses the .xls with SheetJS (already a dep) and posts the rows here,
// so we don't need multipart parsing in the API layer.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { normalizeCustomerRows } from '../../../lib/md-importers/customers'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '40mb' } } }

const SUPPORTED = ['customers','job_types','vehicles','inventory','quotes','invoices','purchase_orders'] as const
type ImportType = typeof SUPPORTED[number]

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

    const type = String(body.type || '') as ImportType
    if (!SUPPORTED.includes(type)) return res.status(400).json({ error: `Unsupported type. Use one of: ${SUPPORTED.join(', ')}` })
    const filename = String(body.filename || 'upload.xls').slice(0, 200)
    const rawRows = Array.isArray(body.raw_rows) ? body.raw_rows : null
    if (!rawRows) return res.status(400).json({ error: 'raw_rows (array) required' })

    let parsedRows: any[] = []
    let summary: any = null
    if (type === 'customers') {
      const r = normalizeCustomerRows(rawRows)
      parsedRows = r.rows
      summary = r.summary
    } else {
      return res.status(501).json({ error: `Importer for "${type}" not implemented yet — coming soon.` })
    }

    const { data, error } = await db.from('md_imports').insert({
      type, filename, uploaded_by: user.id, status: 'parsed',
      parsed_summary: summary, parsed_data: parsedRows,
    }).select('id, parsed_summary').single()
    if (error) return res.status(500).json({ error: error.message })

    return res.status(201).json({ id: data!.id, parsed_summary: (data as any).parsed_summary })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

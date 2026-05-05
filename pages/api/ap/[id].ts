// pages/api/ap/[id].ts
// AP invoice detail endpoint.
//   GET    /api/ap/{id}         → full invoice + lines + signed PDF URL
//                                  + linkedJob (if linked_job_number is set)
//   PATCH  /api/ap/{id}         → update header fields

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { getInvoicePdfSignedUrl, applyTriageAndResolve } from '../../../lib/ap-supabase'
import { roleHasPermission } from '../../../lib/permissions'
import { getJobByNumber } from '../../../lib/ap-job-link'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const PATCHABLE_FIELDS = new Set([
  'vendor_name_parsed',
  'invoice_number',
  'invoice_date',
  'po_number',
  'due_date',
  'subtotal_ex_gst',
  'gst_amount',
  'total_inc_gst',
  'notes',
  'resolved_supplier_uid',
  'resolved_supplier_name',
  'resolved_account_uid',
  'resolved_account_code',
  'myob_company_file',
  'status',
  'rejection_reason',
])

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') return handleGet(id, res)
  if (req.method === 'PATCH') return handlePatch(id, req, res, user)
  return res.status(405).json({ error: 'Method not allowed' })
})

async function handleGet(id: string, res: NextApiResponse) {
  const c = sb()
  const { data: inv, error } = await c.from('ap_invoices').select('*').eq('id', id).maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })

  const { data: lines, error: linesErr } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', id)
    .order('line_no', { ascending: true })
  if (linesErr) return res.status(500).json({ error: linesErr.message })

  let pdfUrl: string | null = null
  if (inv.pdf_storage_path) {
    try {
      pdfUrl = await getInvoicePdfSignedUrl(inv.pdf_storage_path)
    } catch (e: any) {
      console.error(`Could not sign URL for ${inv.pdf_storage_path}:`, e?.message)
    }
  }

  // Fetch linked job details if present
  let linkedJob: any = null
  if (inv.linked_job_number) {
    try {
      linkedJob = await getJobByNumber(inv.linked_job_number)
    } catch (e: any) {
      console.error(`getJobByNumber failed for ${inv.linked_job_number}:`, e?.message)
    }
  }

  return res.status(200).json({
    invoice: inv,
    lines: lines || [],
    pdfUrl,
    linkedJob,
  })
}

async function handlePatch(id: string, req: NextApiRequest, res: NextApiResponse, user: any) {
  if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
  }

  const body = (req.body || {}) as Record<string, any>
  const update: Record<string, any> = {}
  for (const k of Object.keys(body)) {
    if (PATCHABLE_FIELDS.has(k)) update[k] = body[k]
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No patchable fields supplied' })
  }

  const c = sb()
  const { error } = await c.from('ap_invoices').update(update).eq('id', id)
  if (error) return res.status(500).json({ error: error.message })

  // Re-run triage if any field that affects it was changed (including po_number,
  // since it drives PO match)
  const triageRelevant = [
    'vendor_name_parsed','invoice_number','total_inc_gst','subtotal_ex_gst',
    'gst_amount','resolved_supplier_uid','resolved_account_uid','po_number',
  ]
  if (triageRelevant.some(f => f in update)) {
    try { await applyTriageAndResolve(id) } catch (e: any) {
      console.error('Re-triage after PATCH failed:', e?.message)
    }
  }

  return handleGet(id, res)
}

// pages/api/ap/[id]/lines.ts
// Bulk-replace line items for an invoice.
// PUT body: { lines: [{ line_no, part_number, description, qty, uom,
//                       unit_price_ex_gst, line_total_ex_gst, gst_amount, tax_code }] }
//
// Strategy: delete-all-then-insert-all inside a single API call. Simpler than
// per-line diff and the line count is small (typically 1-20). Re-runs triage
// after the replace so the row's status reflects the new line totals.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyTriageAndResolve } from '../../../../lib/ap-supabase'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_TAX_CODES = new Set(['GST','FRE','CAP','EXP','GNR','ITS','N-T'])

interface IncomingLine {
  line_no?: number | string
  part_number?: string | null
  description?: string
  qty?: number | string | null
  uom?: string | null
  unit_price_ex_gst?: number | string | null
  line_total_ex_gst?: number | string
  gst_amount?: number | string | null
  tax_code?: string
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed — use PUT' })
  }

  const body = (req.body || {}) as { lines?: IncomingLine[] }
  if (!Array.isArray(body.lines)) {
    return res.status(400).json({ error: 'body.lines must be an array' })
  }

  // Validate + normalise
  const normalised: any[] = []
  for (let i = 0; i < body.lines.length; i++) {
    const raw = body.lines[i] || {}
    const description = typeof raw.description === 'string' ? raw.description.trim() : ''
    if (!description) {
      return res.status(400).json({ error: `lines[${i}].description is required` })
    }
    const taxCode = typeof raw.tax_code === 'string' ? raw.tax_code.toUpperCase() : 'GST'
    if (!VALID_TAX_CODES.has(taxCode)) {
      return res.status(400).json({ error: `lines[${i}].tax_code '${taxCode}' is not valid (use one of ${Array.from(VALID_TAX_CODES).join(', ')})` })
    }
    const lineNo = numOrNull(raw.line_no)
    const lineTotal = numOrNull(raw.line_total_ex_gst)
    if (lineTotal === null) {
      return res.status(400).json({ error: `lines[${i}].line_total_ex_gst is required and must be a number` })
    }
    normalised.push({
      invoice_id:        id,
      line_no:           lineNo !== null && lineNo > 0 ? Math.round(lineNo) : i + 1,
      part_number:       trimOrNull(raw.part_number),
      description,
      qty:               numOrNull(raw.qty),
      uom:               trimOrNull(raw.uom),
      unit_price_ex_gst: numOrNull(raw.unit_price_ex_gst),
      line_total_ex_gst: lineTotal,
      gst_amount:        numOrNull(raw.gst_amount),
      tax_code:          taxCode,
    })
  }

  const c = sb()

  // Confirm invoice exists before mutating lines
  const { data: inv, error: invErr } = await c.from('ap_invoices').select('id, status').eq('id', id).maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })

  // Block editing once posted to MYOB
  if (inv.status === 'posted') {
    return res.status(409).json({ error: 'Cannot edit lines on a posted invoice' })
  }

  // Replace: delete then insert
  const { error: delErr } = await c.from('ap_invoice_lines').delete().eq('invoice_id', id)
  if (delErr) return res.status(500).json({ error: 'delete failed: ' + delErr.message })

  if (normalised.length > 0) {
    const { error: insErr } = await c.from('ap_invoice_lines').insert(normalised)
    if (insErr) return res.status(500).json({ error: 'insert failed: ' + insErr.message })
  }

  // Re-run triage based on new line totals
  try {
    await applyTriageAndResolve(id)
  } catch (e: any) {
    console.error('Re-triage after lines replace failed:', e?.message)
  }

  // Return new state
  const { data: lines } = await c
    .from('ap_invoice_lines')
    .select('*')
    .eq('invoice_id', id)
    .order('line_no', { ascending: true })

  return res.status(200).json({ ok: true, lines: lines || [] })
})

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function trimOrNull(v: any): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

// pages/api/ap/index.ts
// AP invoice list endpoint.
// GET /api/ap?status=pending_review&triage=red&q=repco&limit=50&offset=0
//
// Each row now carries a `line_summary` field with the first line item's
// part_number + description (truncated) and a "+N more" suffix when there
// are multiple lines. Drives the Description column on the list view.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const SUMMARY_MAX_LEN = 80

function buildLineSummary(lines: Array<{ part_number: string | null; description: string | null }>): string | null {
  if (!lines || lines.length === 0) return null
  const first = lines[0]
  const head = [first.part_number, first.description]
    .map(s => (s || '').trim())
    .filter(Boolean)
    .join(' — ')
  if (!head) return lines.length > 1 ? `(unnamed) +${lines.length - 1} more` : null
  const truncated = head.length > SUMMARY_MAX_LEN ? head.substring(0, SUMMARY_MAX_LEN - 1) + '…' : head
  return lines.length > 1 ? `${truncated} +${lines.length - 1} more` : truncated
}

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const status   = String(req.query.status || '').trim()
  const triage   = String(req.query.triage || '').trim()
  const q        = String(req.query.q || '').trim().toLowerCase()
  const limit    = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10), 1), 200)
  const offset   = Math.max(parseInt(String(req.query.offset || '0'), 10), 0)

  let query = sb()
    .from('ap_invoices')
    .select(`
      id, source, received_at, pdf_filename,
      vendor_name_parsed, invoice_number, invoice_date, due_date,
      subtotal_ex_gst, gst_amount, total_inc_gst,
      via_capricorn, capricorn_reference,
      parse_confidence,
      resolved_supplier_uid, resolved_supplier_name, resolved_account_code,
      payment_account_uid, payment_account_code, payment_account_name,
      triage_status, triage_reasons,
      status, myob_company_file, myob_bill_uid, myob_posted_at, myob_post_error
    `, { count: 'exact' })

  if (status)   query = query.eq('status', status)
  if (triage)   query = query.eq('triage_status', triage)
  if (q) {
    // Supabase: ilike across the most useful columns. Use OR.
    query = query.or(
      `vendor_name_parsed.ilike.%${q}%,invoice_number.ilike.%${q}%,resolved_supplier_name.ilike.%${q}%`
    )
  }

  query = query.order('received_at', { ascending: false }).range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) return res.status(500).json({ error: error.message })

  // ── Line summaries ──
  // One follow-up query for the lines of just-listed invoices, grouped by
  // invoice_id with line_no=1 first. Doing it as a follow-up is simpler
  // than wiring a Postgres function and only adds 1 round-trip for the
  // page (typically <50 invoices visible).
  const invoices = (data || []) as any[]
  const ids = invoices.map(i => i.id)
  const summaryByInvoice = new Map<string, string | null>()

  if (ids.length > 0) {
    const { data: lineRows, error: linesErr } = await sb()
      .from('ap_invoice_lines')
      .select('invoice_id, line_no, part_number, description')
      .in('invoice_id', ids)
      .order('invoice_id', { ascending: true })
      .order('line_no', { ascending: true })

    if (!linesErr && lineRows) {
      const grouped = new Map<string, Array<{ part_number: string | null; description: string | null }>>()
      for (const row of lineRows as any[]) {
        const arr = grouped.get(row.invoice_id) || []
        arr.push({ part_number: row.part_number, description: row.description })
        grouped.set(row.invoice_id, arr)
      }
      grouped.forEach((arr, invId) => {
        summaryByInvoice.set(invId, buildLineSummary(arr))
      })
    }
  }

  const invoicesWithSummary = invoices.map(inv => ({
    ...inv,
    line_summary: summaryByInvoice.get(inv.id) || null,
  }))

  // ── Compact summary numbers for the page header ──
  const { data: summary } = await sb()
    .from('ap_invoices')
    .select('triage_status, status', { count: 'exact', head: false })

  const counts = { red: 0, yellow: 0, green: 0, pending: 0, posted: 0, ready: 0 }
  for (const row of (summary || []) as any[]) {
    if (row.triage_status === 'red')    counts.red++
    if (row.triage_status === 'yellow') counts.yellow++
    if (row.triage_status === 'green')  counts.green++
    if (row.status === 'pending_review') counts.pending++
    if (row.status === 'ready')          counts.ready++
    if (row.status === 'posted')         counts.posted++
  }

  return res.status(200).json({
    invoices: invoicesWithSummary,
    total: count ?? 0,
    limit,
    offset,
    counts,
  })
})

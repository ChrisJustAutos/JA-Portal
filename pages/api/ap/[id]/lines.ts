// pages/api/ap/[id]/lines.ts
// Bulk-replace line items for an invoice.
//
// PUT body: { lines: [{
//   line_no, part_number, description, qty, uom,
//   unit_price_ex_gst, line_total_ex_gst, gst_amount, tax_code,
//   account_uid?, account_code?, account_name?, account_source?
// }] }
//
// Strategy: delete-all-then-insert-all inside a single API call. Simpler
// than per-line diff; line counts are small (typically 1-20). Re-runs
// triage after the replace so the row's status reflects the new line
// totals and the smart-pickup resolver gets a chance to fill in
// suggestions / rule-applied accounts.
//
// account_source semantics (drives the smart-pickup resolver — see
// lib/ap-line-resolver.ts):
//   - 'manual'           — user explicitly picked. NEVER overwritten.
//   - 'rule'             — auto-applied from ap_line_account_rules.
//   - 'history-strong'   — auto-applied from ap_line_account_history.
//   - 'history-weak'     — suggestion only (in suggested_*); not applied.
//   - 'unset'            — no decision yet.
//   - 'supplier-default' — explicit accept-the-fallback.
//
// Defaulting: if the body sends an account_uid but no account_source,
// we treat that as a manual pick (this is the conservative fallback for
// older callers). If account_uid is null, source defaults to 'unset'.
// The UI (pages/ap/[id].tsx) sends account_source explicitly.

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
const VALID_ACCOUNT_SOURCES = new Set([
  'unset', 'rule', 'history-strong', 'history-weak', 'keyword-match', 'manual', 'supplier-default',
])
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  account_uid?: string | null
  account_code?: string | null
  account_name?: string | null
  account_source?: string | null
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

    const accountUid = trimOrNull(raw.account_uid)
    if (accountUid !== null && !UUID_REGEX.test(accountUid)) {
      return res.status(400).json({ error: `lines[${i}].account_uid must be a UUID` })
    }

    // Validate account_source. If provided but not in the enum, reject.
    // Otherwise apply the defaulting rules: account_uid set → 'manual',
    // not set → 'unset'. The UI sends an explicit value for accuracy.
    const rawSource = trimOrNull(raw.account_source)
    let accountSource: string
    if (rawSource !== null) {
      if (!VALID_ACCOUNT_SOURCES.has(rawSource)) {
        return res.status(400).json({ error: `lines[${i}].account_source '${rawSource}' is not valid (use one of ${Array.from(VALID_ACCOUNT_SOURCES).join(', ')})` })
      }
      accountSource = rawSource
    } else {
      accountSource = accountUid ? 'manual' : 'unset'
    }

    // Coherence: if no account_uid, source must be 'unset' (otherwise the
    // resolver won't run on this line). Cleaner to enforce here than to
    // surprise callers with silently-mutated state on read-back.
    if (!accountUid && accountSource !== 'unset') {
      accountSource = 'unset'
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
      account_uid:       accountUid,
      account_code:      accountUid ? trimOrNull(raw.account_code) : null,
      account_name:      accountUid ? trimOrNull(raw.account_name) : null,
      account_source:    accountSource,
      // Suggestions are recomputed by the resolver during applyTriageAndResolve
      // — clear any stale values that might have come back from the UI.
      suggested_account_uid:  null,
      suggested_account_code: null,
      suggested_account_name: null,
    })
  }

  const c = sb()

  const { data: inv, error: invErr } = await c.from('ap_invoices').select('id, status').eq('id', id).maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })

  if (inv.status === 'posted') {
    return res.status(409).json({ error: 'Cannot edit lines on a posted invoice' })
  }

  const { error: delErr } = await c.from('ap_invoice_lines').delete().eq('invoice_id', id)
  if (delErr) return res.status(500).json({ error: 'delete failed: ' + delErr.message })

  if (normalised.length > 0) {
    const { error: insErr } = await c.from('ap_invoice_lines').insert(normalised)
    if (insErr) return res.status(500).json({ error: 'insert failed: ' + insErr.message })
  }

  // Re-triage runs the resolver, which:
  //   - skips lines marked 'manual'
  //   - fills account_uid OR suggested_account_* on others
  //   - bumps rule hits when matched
  try {
    await applyTriageAndResolve(id)
  } catch (e: any) {
    console.error('Re-triage after lines replace failed:', e?.message)
  }

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

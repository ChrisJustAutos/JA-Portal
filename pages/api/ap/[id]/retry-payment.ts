// pages/api/ap/[id]/retry-payment.ts
// Retry applying the Purchase Payment for an invoice that has already
// posted to MYOB (myob_bill_uid set) but where the initial payment call
// failed (myob_payment_error set, myob_payment_uid null).
//
// Common reason this exists: the previous deploy used a wrong endpoint
// path (/Purchase/PaymentTxn instead of /Purchase/SupplierPayment) and
// MYOB returned 401 OAuthTokenIsInvalid for any non-existent path. After
// deploying the fix, this endpoint lets editors retry on the stuck rows
// without having to manually re-approve.
//
// POST /api/ap/{id}/retry-payment
//   - 409 if the invoice has no bill UID, no payment account, or already
//     has a payment UID applied
//   - 200 with { ok, paymentUid } on success
//   - 502 with the MYOB error on failure (myob_payment_error updated)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyBillPayment } from '../../../../lib/ap-payment'
import { getConnection } from '../../../../lib/myob'
import type { CompanyFileLabel } from '../../../../lib/ap-myob-lookup'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: inv, error: invErr } = await c.from('ap_invoices').select('*').eq('id', id).maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv)   return res.status(404).json({ error: 'Invoice not found' })

  if (!inv.myob_bill_uid) {
    return res.status(409).json({ error: 'Invoice has no posted MYOB bill UID — approve it first.' })
  }
  if (!inv.payment_account_uid) {
    return res.status(409).json({ error: 'No payment account selected on this invoice.' })
  }
  if (inv.myob_payment_uid) {
    return res.status(409).json({ error: 'Payment already applied (UID ' + String(inv.myob_payment_uid).substring(0, 8) + '…).' })
  }
  if (!inv.resolved_supplier_uid) {
    return res.status(409).json({ error: 'No MYOB supplier resolved.' })
  }

  const total = inv.total_inc_gst != null ? Number(inv.total_inc_gst) : 0
  if (!Number.isFinite(total) || total <= 0) {
    return res.status(409).json({ error: `Invoice total invalid (${inv.total_inc_gst})` })
  }

  const cfLabel = (inv.myob_company_file || 'VPS') as CompanyFileLabel
  const conn = await getConnection(cfLabel)
  if (!conn) return res.status(500).json({ error: `No active MYOB connection for ${cfLabel}` })
  if (!conn.company_file_id) return res.status(500).json({ error: `MYOB connection ${cfLabel} has no company file selected` })

  try {
    const r = await applyBillPayment({
      connId:         conn.id,
      cfId:           conn.company_file_id,
      date:           inv.invoice_date,
      fromAccountUid: String(inv.payment_account_uid),
      supplierUid:    String(inv.resolved_supplier_uid),
      billUid:        String(inv.myob_bill_uid),
      amount:         total,
      memo:           `Retry payment ${inv.via_capricorn ? '(Capricorn)' : ''} — ${inv.invoice_number || 'AP'}`.trim(),
      performedBy:    user.id,
    })

    // Strip any "Payment apply failed: …" note that the original bill post
    // appended to myob_post_error so the AP detail header doesn't keep
    // showing "Payment failed" after a successful retry. Other notes in
    // that column (PDF attach issues etc.) are preserved.
    const postErrParts = String(inv.myob_post_error || '')
      .split(' · ')
      .map(s => s.trim())
      .filter(s => s && !s.toLowerCase().startsWith('payment apply failed'))
    const cleanedPostError = postErrParts.length > 0 ? postErrParts.join(' · ') : null

    await c.from('ap_invoices').update({
      myob_payment_uid:        r.paymentUid,
      myob_payment_applied_at: new Date().toISOString(),
      myob_payment_error:      null,
      myob_post_error:         cleanedPostError,
    }).eq('id', id)

    return res.status(200).json({ ok: true, paymentUid: r.paymentUid })
  } catch (e: any) {
    const msg = (e?.message || String(e)).substring(0, 500)
    await c.from('ap_invoices').update({
      myob_payment_error: msg,
    }).eq('id', id)
    return res.status(502).json({ error: msg })
  }
})

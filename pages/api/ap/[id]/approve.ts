// pages/api/ap/[id]/approve.ts
// POST /api/ap/{id}/approve — pushes the AP invoice to MYOB as a Service Bill.
//
// Returns:
//   200 { ok: true, myobBillUid, myobBillRowId }
//   409 { error: 'Already posted' | 'Triage RED' | 'Validation: ...' }
//   502 { error: 'MYOB rejected the bill: ...' }
//
// Idempotency: if the invoice is already posted (status='posted' AND
// myob_bill_uid set), we return 409 with the existing UID — never re-post.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createServiceBill, createSpendMoneyTxn } from '../../../../lib/ap-myob-bill'
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
  }

  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'invoice id required' })

  // Idempotency check
  const { data: inv, error: fetchErr } = await sb()
    .from('ap_invoices')
    .select('id, status, myob_bill_uid, triage_status, resolved_supplier_uid, payment_account_uid')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!inv)     return res.status(404).json({ error: 'Invoice not found' })

  if (inv.status === 'posted' && inv.myob_bill_uid) {
    return res.status(409).json({
      error: 'Already posted to MYOB',
      myobBillUid: inv.myob_bill_uid,
    })
  }

  // Optional override: if the request body includes paymentAccountUid,
  // and the invoice has no supplier mapped, treat it as a Spend Money
  // post against that account. This lets the AP list "Spend Money" button
  // pick an account at click-time without first opening the detail page.
  // accountUid (the destination expense/asset account) is optional — when
  // provided, the spend posts as a single line at that account, ignoring
  // any per-line triage on the invoice.
  const body = (req.body || {}) as Record<string, any>
  const paymentAccountUid = typeof body.paymentAccountUid === 'string'
    ? body.paymentAccountUid.trim() : ''
  const accountUid = typeof body.accountUid === 'string'
    ? body.accountUid.trim() : ''
  if (paymentAccountUid && !inv.resolved_supplier_uid) {
    // Look up account details to keep ap_invoices in sync (code + name).
    const { data: acct } = await sb()
      .from('ap_payment_accounts')
      .select('account_uid, account_code, account_name')
      .eq('account_uid', paymentAccountUid)
      .maybeSingle()
    if (!acct) return res.status(400).json({ error: 'paymentAccountUid not found in ap_payment_accounts' })
    const { error: updErr } = await sb().from('ap_invoices').update({
      payment_account_uid:  acct.account_uid,
      payment_account_code: acct.account_code,
      payment_account_name: acct.account_name,
    }).eq('id', id)
    if (updErr) return res.status(500).json({ error: 'Failed to set payment account: ' + updErr.message })
    inv.payment_account_uid = acct.account_uid
  }

  // Path selection:
  //   - supplier mapped              → Service Bill (the default)
  //   - no supplier + payment_account → Spend Money (clearing/bank account)
  //   - no supplier + no payment_acc  → reject (need one of the two to post)
  const useSpendMoney = !inv.resolved_supplier_uid && !!inv.payment_account_uid

  // Triage RED is normally blocking, but the explicit Spend-Money override
  // (paymentAccountUid + accountUid in the request body) implies the user
  // has already made the routing decisions that triage was waiting for,
  // so we let it through.
  const explicitSpendMoneyOverride = !!paymentAccountUid && !!accountUid && useSpendMoney
  if (inv.triage_status === 'red' && !explicitSpendMoneyOverride) {
    return res.status(409).json({ error: 'Cannot post — triage is RED. Resolve issues first.' })
  }

  try {
    const result = useSpendMoney
      ? await createSpendMoneyTxn(id, user.id, accountUid ? { singleLineAccountUid: accountUid } : undefined)
      : await createServiceBill(id, user.id)
    return res.status(200).json({ ...result, postedAs: useSpendMoney ? 'spend_money' : 'bill' })
  } catch (e: any) {
    const msg = e?.message || String(e)
    // Distinguish validation vs MYOB-rejection vs network
    if (msg.startsWith('MYOB rejected')) {
      return res.status(502).json({ error: msg })
    }
    if (
      msg.includes('not found') ||
      msg.includes('No MYOB') ||
      msg.includes('triage') ||
      msg.includes('required to post') ||
      msg.includes('no line items') ||
      msg.includes('Unsupported tax')
    ) {
      return res.status(409).json({ error: msg })
    }
    console.error('approve failed:', msg)
    return res.status(500).json({ error: msg })
  }
})

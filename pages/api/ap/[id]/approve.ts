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
  if (inv.triage_status === 'red') {
    return res.status(409).json({ error: 'Cannot post — triage is RED. Resolve issues first.' })
  }

  // Path selection:
  //   - supplier mapped              → Service Bill (the default)
  //   - no supplier + payment_account → Spend Money (clearing/bank account)
  //   - no supplier + no payment_acc  → reject (need one of the two to post)
  const useSpendMoney = !inv.resolved_supplier_uid && !!inv.payment_account_uid

  try {
    const result = useSpendMoney
      ? await createSpendMoneyTxn(id, user.id)
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

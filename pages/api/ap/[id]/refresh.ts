// pages/api/ap/[id]/refresh.ts
// Re-runs the full AP triage pipeline on a single invoice and queries MYOB
// for an existing bill with the same supplier+invoice-number. Lets the
// editor force a re-check after editing fields, or to catch a manual MYOB
// entry that was created outside the portal.
//
// POST /api/ap/{id}/refresh
//   → {
//       ok: true,
//       triage: { status, reasonCount },
//       myobMatch: null | { uid, number, date, totalAmount },
//       adoptedBillUid: string | null,    // set if the row was updated to
//                                         // adopt a manual MYOB entry
//     }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyTriageAndResolve } from '../../../../lib/ap-supabase'
import { findExistingMyobBill } from '../../../../lib/ap-myob-bill'
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

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()

  // ── 1. Re-run portal triage ──
  // Handles supplier resolution, exact-match + amount-window dup checks,
  // PO→job auto-link, and the line account resolver.
  try {
    await applyTriageAndResolve(id)
  } catch (e: any) {
    return res.status(500).json({ error: 'Triage refresh failed: ' + (e?.message || String(e)) })
  }

  const { data: inv, error: invErr } = await c.from('ap_invoices').select('*').eq('id', id).maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv)   return res.status(404).json({ error: 'Invoice not found' })

  // ── 2. Check MYOB for an existing bill with the same supplier+invoice-number ──
  let myobMatch: Awaited<ReturnType<typeof findExistingMyobBill>> = null
  let adoptedBillUid: string | null = null
  let myobCheckError: string | null = null

  if (inv.resolved_supplier_uid && inv.invoice_number) {
    try {
      const cf = (inv.myob_company_file || 'VPS') as CompanyFileLabel
      const conn = await getConnection(cf)
      if (conn?.company_file_id) {
        myobMatch = await findExistingMyobBill(
          conn.id,
          conn.company_file_id,
          String(inv.invoice_number),
          String(inv.resolved_supplier_uid),
        )

        // If MYOB has a bill that the row didn't know about (was probably
        // entered manually after our last sync), adopt it now so subsequent
        // approve/retry-payment calls have the right UID to work against.
        if (myobMatch && !inv.myob_bill_uid && myobMatch.uid !== conn.company_file_id) {
          await c.from('ap_invoices').update({
            myob_bill_uid:      myobMatch.uid,
            myob_posted_at:     myobMatch.date || new Date().toISOString(),
            status:             'posted',
            myob_post_error:    `Adopted existing MYOB bill #${myobMatch.number || '?'} on refresh.`,
          }).eq('id', id)
          adoptedBillUid = myobMatch.uid
        }
      }
    } catch (e: any) {
      myobCheckError = (e?.message || String(e)).substring(0, 300)
      console.error(`[refresh] MYOB existing-bill check for ${id} failed: ${myobCheckError}`)
    }
  }

  return res.status(200).json({
    ok: true,
    triage: {
      status:      inv.triage_status,
      reasonCount: Array.isArray(inv.triage_reasons) ? inv.triage_reasons.length : 0,
    },
    myobMatch,
    adoptedBillUid,
    myobCheckError,
  })
})

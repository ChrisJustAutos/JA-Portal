// pages/api/admin/inspect-stock-transfers.ts
//
// One-off READ-ONLY diagnostic: for every B2B stock transfer we hold a
// document UID for, fetch the live MYOB record and report whether it still
// exists — which supplier/customer card it's on, its number, date and total.
//
// Why: the portal recorded a jaws_invoice_uid + vps_bill_uid for each forward
// transfer (from real 201 Created responses), but a June-2026 reconciliation
// showed JAWS raised ~$43k of transfer sale invoices to VPS while VPS's
// payables to "Just Autos Wholesale" only carried ~$2.5k. This tells us,
// per transfer, whether each side's document is still present in MYOB (and on
// which card) so we can see if the missing VPS bills were deleted, or landed
// on the wrong supplier card.
//
// Auth: bearer CRON_SECRET (same as the cron/inspect endpoints).
//
// Usage:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://justautos.app/api/admin/inspect-stock-transfers"
//
// Read-only. Safe to delete after we've reconciled.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from '../../../lib/myob'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Fetch one MYOB doc by UID and normalise the bits we care about.
async function probe(
  connId: string,
  cfId: string,
  endpoint: string,        // e.g. 'Sale/Invoice/Item' | 'Purchase/Bill/Service'
  uid: string | null,
): Promise<any> {
  if (!uid) return { uid: null, present: false, note: 'no UID recorded' }
  try {
    const r = await myobFetch(connId, `/accountright/${cfId}/${endpoint}/${uid}`)
    if (r.status === 404) return { uid, present: false, httpStatus: 404, note: 'not found (deleted?)' }
    if (r.status !== 200) return { uid, present: false, httpStatus: r.status, note: (r.raw || '').slice(0, 200) }
    const d = r.data || {}
    return {
      uid,
      present: true,
      httpStatus: 200,
      number: d.Number ?? null,
      date: d.Date ?? null,
      supplier: d.Supplier?.Name ?? null,
      supplierUid: d.Supplier?.UID ?? null,
      customer: d.Customer?.Name ?? null,
      customerUid: d.Customer?.UID ?? null,
      totalAmount: d.TotalAmount ?? null,
      balanceDue: d.BalanceDueAmount ?? null,
      status: d.Status ?? null,
    }
  } catch (e: any) {
    return { uid, present: false, error: (e?.message || String(e)).slice(0, 200) }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  try {
    const jaws = await getConnection('JAWS')
    const vps = await getConnection('VPS')
    if (!jaws?.company_file_id) return res.status(400).json({ error: 'No JAWS MYOB connection / company file' })
    if (!vps?.company_file_id) return res.status(400).json({ error: 'No VPS MYOB connection / company file' })

    const c = sb()
    const { data: transfers, error } = await c
      .from('b2b_stock_transfers')
      .select('id, direction, status, po_reference, total_inc, jaws_invoice_number, jaws_invoice_uid, vps_bill_uid, vps_invoice_uid, jaws_bill_uid, created_at')
      .order('created_at', { ascending: false })
      .limit(60)
    if (error) return res.status(500).json({ error: error.message })

    const rows: any[] = []
    for (const t of transfers || []) {
      const forward = (t.direction || 'JAWS_TO_VPS') !== 'VPS_TO_JAWS'
      // Forward: JAWS Sale/Invoice/Item (receivable) + VPS Purchase/Bill/Service (payable).
      // Reverse: VPS Sale/Invoice/Service + JAWS Purchase/Bill/Item.
      const [saleSide, purchaseSide] = forward
        ? [
            await probe(jaws.id, jaws.company_file_id, 'Sale/Invoice/Item', t.jaws_invoice_uid),
            await probe(vps.id, vps.company_file_id, 'Purchase/Bill/Service', t.vps_bill_uid),
          ]
        : [
            await probe(vps.id, vps.company_file_id, 'Sale/Invoice/Service', t.vps_invoice_uid),
            await probe(jaws.id, jaws.company_file_id, 'Purchase/Bill/Item', t.jaws_bill_uid),
          ]
      rows.push({
        transferId: t.id,
        created: t.created_at,
        direction: t.direction,
        portalStatus: t.status,
        po: t.po_reference,
        jawsInvoiceNumber: t.jaws_invoice_number,
        portalTotalInc: Number(t.total_inc),
        saleSide,      // the doc that raises the receivable
        purchaseSide,  // the mirror bill that should raise the matching payable
        mirrored: !!(saleSide.present && purchaseSide.present),
      })
    }

    const missingPurchase = rows.filter(r => r.saleSide.present && !r.purchaseSide.present)
    return res.status(200).json({
      ok: true,
      jawsCompanyFile: jaws.company_file_name,
      vpsCompanyFile: vps.company_file_name,
      count: rows.length,
      summary: {
        mirrored: rows.filter(r => r.mirrored).length,
        purchaseSideMissing: missingPurchase.length,
        missingPurchaseTotalInc: missingPurchase.reduce((s, r) => s + (r.portalTotalInc || 0), 0),
        missingList: missingPurchase.map(r => ({ jawsInvoiceNumber: r.jawsInvoiceNumber, total: r.portalTotalInc, billUid: r.purchaseSide.uid, note: r.purchaseSide.note || r.purchaseSide.error })),
      },
      transfers: rows,
    })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

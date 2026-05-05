// pages/api/ap/bulk-approve.ts
// Bulk-approve several AP invoices at once. POSTs each to MYOB sequentially
// (parallel calls would race against MYOB rate limits and the same OAuth
// connection record).
//
// POST /api/ap/bulk-approve  { invoiceIds: string[] }   max 50 per call
//
// Each id is run through createServiceBill() — the same path /api/ap/[id]/
// approve uses. Per-id results are returned (ok / billUid / attachment
// status, or error). Caller (the list page) aggregates and renders.
//
// Auth: edit:supplier_invoices.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { createServiceBill } from '../../../lib/ap-myob-bill'

export const config = { maxDuration: 300 }

interface PerIdResult {
  id: string
  ok: boolean
  billUid?: string
  attachmentStatus?: 'attached' | 'failed' | 'skipped' | 'no-pdf'
  attachmentError?: string
  error?: string
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { invoiceIds } = (req.body || {}) as { invoiceIds?: string[] }
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return res.status(400).json({ error: 'invoiceIds (string[]) required' })
  }
  if (invoiceIds.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 invoices per batch' })
  }

  const userEmail: string = (req as any).user?.email || 'bulk-approve'
  const results: PerIdResult[] = []

  for (const id of invoiceIds) {
    if (typeof id !== 'string' || !id) {
      results.push({ id: String(id), ok: false, error: 'Invalid id' })
      continue
    }
    try {
      const r = await createServiceBill(id, userEmail)
      results.push({
        id,
        ok: true,
        billUid: r.myobBillUid,
        attachmentStatus: r.attachmentStatus,
        attachmentError: r.attachmentError,
      })
    } catch (e: any) {
      results.push({ id, ok: false, error: (e?.message || String(e)).substring(0, 400) })
    }
  }

  const summary = {
    total:      results.length,
    succeeded:  results.filter(r => r.ok).length,
    failed:     results.filter(r => !r.ok).length,
    attached:   results.filter(r => r.ok && r.attachmentStatus === 'attached').length,
    attachFail: results.filter(r => r.ok && r.attachmentStatus === 'failed').length,
  }

  return res.status(200).json({ ok: true, summary, results })
})

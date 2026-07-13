// pages/api/vin-codes/observed.ts
// Returns distinct VIN prefixes seen on JAWS sales invoices, with occurrence counts.
// The admin UI uses this to show "prefixes that exist in MYOB but aren't mapped yet".

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../../lib/auth'
import { fetchSaleInvoices } from '../../../lib/myob-reporting'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      // Direct MYOB OAuth (CData decommissioned 2026-07-14): aggregate the
      // 4-char PO-number prefixes in JS. PO number carries the VIN prefix.
      const invs = await fetchSaleInvoices('JAWS', {})
      const agg = new Map<string, { occurrences: number; sample_value: string }>()
      for (const inv of invs) {
        const po = String(inv.CustomerPurchaseOrderNumber || '')
        if (po.length < 8) continue
        const prefix = po.slice(0, 4)
        const e = agg.get(prefix) || { occurrences: 0, sample_value: po }
        e.occurrences += 1
        if (po > e.sample_value) e.sample_value = po
        agg.set(prefix, e)
      }
      const observed = Array.from(agg.entries())
        .map(([prefix, v]) => ({ prefix, occurrences: v.occurrences, sample_value: v.sample_value }))
        .sort((a, b) => b.occurrences - a.occurrences)
      res.status(200).json({ observed, count: observed.length })
    } catch (e: any) {
      console.error('observed VINs error:', e)
      res.status(500).json({ error: e.message || 'Failed to load observed VINs' })
    }
  })
}

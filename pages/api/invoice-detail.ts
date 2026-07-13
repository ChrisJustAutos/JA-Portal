// pages/api/invoice-detail.ts — Fetch line items + payment history for a single invoice.
// All $ amounts in response are ex-GST (frontend applies inc-GST display multiplier).

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { fetchSaleInvoiceByNumber } from '../../lib/myob-reporting'
import { invoiceExGst, lineExGst, toNum, asBool } from '../../lib/gst'

export const config = { maxDuration: 30 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const invoiceNumber = req.query.number as string
    const entity = req.query.entity as string // 'JAWS' or 'VPS'

    if (!invoiceNumber || !entity) {
      return res.status(400).json({ error: 'number and entity params required' })
    }
    if (entity !== 'JAWS' && entity !== 'VPS') {
      return res.status(400).json({ error: 'entity must be JAWS or VPS' })
    }

    // Direct MYOB OAuth (CData decommissioned 2026-07-14): header + lines in one pass.
    const fetched = await fetchSaleInvoiceByNumber(entity, invoiceNumber).catch((e: any) => {
      console.error('invoice-detail:', (e?.message || e).toString().slice(0, 160)); return { invoice: null, lines: [] }
    })
    const rawInvoice = fetched.invoice

    // Add ex-GST fields to header
    let invoice: any = null
    if (rawInvoice) {
      const total = toNum(rawInvoice.TotalAmount)
      const tax = toNum(rawInvoice.TotalTax)
      const balance = toNum(rawInvoice.BalanceDueAmount)
      const balanceTaxRatio = total > 0 ? (tax * balance) / total : 0
      invoice = {
        ...rawInvoice,
        TotalAmountExGst: invoiceExGst(total, tax),
        BalanceDueExGst: balance - balanceTaxRatio,
        // Subtotal when IsTaxInclusive=true actually already equals the ex-GST subtotal
        // for plain-GST invoices, but we expose the canonical SubtotalExGst = TotalAmount - TotalTax
        // for consistency (same formula as TotalAmountExGst).
        SubtotalExGst: invoiceExGst(total, tax),
      }
    }

    // Line items — carry parent's IsTaxInclusive for proper normalisation.
    let lineItemsArr: any[] = []
    if (rawInvoice) {
      const rawLines = fetched.lines
      const parentIsIncGst = asBool(rawInvoice?.IsTaxInclusive)
      lineItemsArr = rawLines.map(line => {
        const rawTotal = toNum(line.Total)
        const rawUnit = toNum(line.UnitPrice)
        return {
          ...line,
          // Line-level ex-GST — depends on BOTH parent's IsTaxInclusive and line's TaxCodeCode
          TotalExGst: lineExGst(rawTotal, parentIsIncGst, line.TaxCodeCode),
          UnitPriceExGst: lineExGst(rawUnit, parentIsIncGst, line.TaxCodeCode),
        }
      })
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.status(200).json({
      amountsAreExGst: true,
      invoice,
      lineItems: lineItemsArr,
    })
  })
}

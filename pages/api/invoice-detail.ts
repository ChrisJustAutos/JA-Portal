// pages/api/invoice-detail.ts — Fetch line items + payment history for a single invoice.
// All $ amounts in response are ex-GST (frontend applies inc-GST display multiplier).

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'
import { invoiceExGst, lineExGst, toNum, asBool } from '../../lib/gst'

export const config = { maxDuration: 30 }

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('invoice-detail:', e.message?.substring(0,160)); return null }
}

function flatten(r: any): any[] {
  if (!r?.results?.[0]) return []
  const cols: string[] = r.results[0].schema.map((c: any) => c.columnName)
  const rows: any[][] = r.results[0].rows || []
  return rows.map((row) => {
    const o: any = {}
    cols.forEach((c, i) => { o[c] = row[i] })
    return o
  })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const invoiceNumber = req.query.number as string
    const entity = req.query.entity as string // 'JAWS' or 'VPS'

    if (!invoiceNumber || !entity) {
      return res.status(400).json({ error: 'number and entity params required' })
    }

    const catalog = entity === 'JAWS' ? 'MYOB_POWERBI_JAWS' : 'MYOB_POWERBI_VPS'
    const safeNumber = invoiceNumber.replace(/'/g, "''")

    // Step 1: fetch invoice header INCLUDING IsTaxInclusive (needed to normalise line items)
    const invoiceHeaderRaw: any = await safe(() => cdataQuery(entity, `
      SELECT [ID],[Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],
             [Subtotal],[TotalTax],[IsTaxInclusive],[InvoiceType],[Comment],[ShipToAddress],
             [CustomerPurchaseOrderNumber],[TermsDueDate],[TermsPaymentIsDue],
             [SalespersonName],[JournalMemo],[Freight],[LastPaymentDate]
      FROM [${catalog}].[MYOB].[SaleInvoices]
      WHERE [Number] = '${safeNumber}'
    `))

    const invoiceRows = flatten(invoiceHeaderRaw)
    const rawInvoice = invoiceRows[0] || null
    const invoiceId = rawInvoice?.ID || null

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

    // Step 2: fetch line items — now includes parent's IsTaxInclusive for proper normalisation
    let lineItemsArr: any[] = []
    if (invoiceId) {
      const lineItemsRaw: any = await safe(() => cdataQuery(entity, `
        SELECT [Description],[Total],[ShipQuantity],[UnitPrice],[TaxCodeCode],[AccountName],[AccountDisplayID],[ItemName],[RowID]
        FROM [${catalog}].[MYOB].[SaleInvoiceItems]
        WHERE [SaleInvoiceId] = '${invoiceId}'
        ORDER BY [RowID]
      `))
      const rawLines = flatten(lineItemsRaw)
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

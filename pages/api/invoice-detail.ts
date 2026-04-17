// pages/api/invoice-detail.ts — Fetch line items + payment history for a single invoice
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 30 }

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('invoice-detail:', e.message?.substring(0,80)); return null }
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

    // Step 1: fetch the invoice header to get its UUID
    const invoiceHeader: any = await safe(() => cdataQuery(entity, `
      SELECT [ID],[Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],
             [Subtotal],[TotalTax],[InvoiceType],[Comment],[ShipToAddress],
             [CustomerPurchaseOrderNumber],[Terms]
      FROM [${catalog}].[MYOB].[SaleInvoices]
      WHERE [Number] = '${safeNumber}'
    `))

    // Extract the invoice UUID from the result so we can query line items
    const hdrCols: string[] = invoiceHeader?.results?.[0]?.schema?.map((c: any) => c.columnName) || []
    const hdrRows: any[][] = invoiceHeader?.results?.[0]?.rows || []
    const idIdx = hdrCols.indexOf('ID')
    const invoiceId = (hdrRows[0] && idIdx >= 0) ? hdrRows[0][idIdx] : null

    // Step 2: fetch line items by SaleInvoiceId (UUID) — only if we found the invoice
    let lineItems: any = null
    if (invoiceId) {
      lineItems = await safe(() => cdataQuery(entity, `
        SELECT [Description],[Total],[ShipQuantity],[UnitPrice],[TaxCodeCode],[AccountName],[AccountDisplayID],[ItemName],[RowID]
        FROM [${catalog}].[MYOB].[SaleInvoiceItems]
        WHERE [SaleInvoiceId] = '${invoiceId}'
        ORDER BY [RowID]
      `))
    }

    res.status(200).json({
      lineItems,
      invoice: invoiceHeader,
    })
  })
}

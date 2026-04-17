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

    // Fetch line items and invoice header in parallel
    const [lineItems, invoiceHeader] = await Promise.all([
      // Line items for this invoice
      safe(() => cdataQuery(entity, `
        SELECT [Description],[Total],[Quantity],[UnitPrice],[TaxCode],[AccountName],[ItemName]
        FROM [${catalog}].[MYOB].[SaleInvoiceItems]
        WHERE [SaleInvoiceNumber] = '${invoiceNumber.replace(/'/g, "''")}'
        ORDER BY [RowOrder]
      `)),
      // Invoice header with payment details
      safe(() => cdataQuery(entity, `
        SELECT [Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],
               [Subtotal],[TotalTax],[InvoiceType],[Comment],[ShipToAddress],
               [CustomerPurchaseOrderNumber],[Terms]
        FROM [${catalog}].[MYOB].[SaleInvoices]
        WHERE [Number] = '${invoiceNumber.replace(/'/g, "''")}'
      `)),
    ])

    res.status(200).json({
      lineItems,
      invoice: invoiceHeader,
    })
  })
}

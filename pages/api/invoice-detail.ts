// pages/api/invoice-detail.ts — Fetch line items + payment history for a single invoice
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export const config = { maxDuration: 30 }

async function safe(fn: () => Promise<any>) {
  try { return await fn() } catch(e: any) { console.error('invoice-detail:', e.message?.substring(0,80)); return null }
}

// Flatten CData result shape {results:[{schema:[{columnName}], rows:[[...]]}]} into array of objects
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

    // Step 1: fetch the invoice header to get its UUID
    const invoiceHeaderRaw: any = await safe(() => cdataQuery(entity, `
      SELECT [ID],[Number],[Date],[CustomerName],[TotalAmount],[BalanceDueAmount],[Status],
             [Subtotal],[TotalTax],[InvoiceType],[Comment],[ShipToAddress],
             [CustomerPurchaseOrderNumber],[Terms]
      FROM [${catalog}].[MYOB].[SaleInvoices]
      WHERE [Number] = '${safeNumber}'
    `))

    const invoiceRows = flatten(invoiceHeaderRaw)
    const invoice = invoiceRows[0] || null
    const invoiceId = invoice?.ID || null

    // Step 2: fetch line items by SaleInvoiceId (UUID)
    let lineItemsArr: any[] = []
    if (invoiceId) {
      const lineItemsRaw: any = await safe(() => cdataQuery(entity, `
        SELECT [Description],[Total],[ShipQuantity],[UnitPrice],[TaxCodeCode],[AccountName],[AccountDisplayID],[ItemName],[RowID]
        FROM [${catalog}].[MYOB].[SaleInvoiceItems]
        WHERE [SaleInvoiceId] = '${invoiceId}'
        ORDER BY [RowID]
      `))
      lineItemsArr = flatten(lineItemsRaw)
    }

    res.status(200).json({
      invoice,          // flat object (or null)
      lineItems: lineItemsArr,   // flat array of line-item objects
    })
  })
}

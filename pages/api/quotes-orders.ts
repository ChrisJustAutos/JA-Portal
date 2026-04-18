// pages/api/quotes-orders.ts
// Returns JAWS quotes and orders — open orders, recently converted orders, and quotes.
// Quotes table is currently empty in MYOB but scaffolded for future use.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

type Row = Record<string, any>

function rowsToObjects(result: any): Row[] {
  if (!result?.results?.[0]) return []
  const { schema, rows } = result.results[0]
  if (!schema || !rows) return []
  return rows.map((row: any[]) => {
    const o: Row = {}
    schema.forEach((c: any, i: number) => { o[c.columnName] = row[i] })
    return o
  })
}

function num(v: any): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await requireAuth(req, res, async () => {
    try {
      // Last 30 days window for "recently converted"
      const today = new Date()
      const d30 = new Date(today)
      d30.setDate(d30.getDate() - 30)
      const d30Str = d30.toISOString().slice(0, 10)

      // ── Open orders (pipeline — not yet invoiced/shipped) ────────────
      const openOrdersResult = await cdataQuery('JAWS', `
        SELECT Number, Date, CustomerName, CustomerDisplayID,
               TotalAmount, BalanceDueAmount, Status,
               Subtotal, TotalTax, Freight, SalespersonName,
               CustomerPurchaseOrderNumber
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleOrders]
        WHERE Status = 'Open'
        ORDER BY Date DESC
      `)
      const openOrders = rowsToObjects(openOrdersResult).map(o => ({
        number: String(o.Number || ''),
        date: o.Date ? String(o.Date) : null,
        customerName: String(o.CustomerName || ''),
        customerDisplayId: o.CustomerDisplayID ? String(o.CustomerDisplayID) : null,
        totalAmount: num(o.TotalAmount),
        balanceDueAmount: num(o.BalanceDueAmount),
        status: String(o.Status || ''),
        subtotal: num(o.Subtotal),
        totalTax: num(o.TotalTax),
        freight: num(o.Freight),
        salespersonName: o.SalespersonName ? String(o.SalespersonName) : null,
        customerPurchaseOrderNumber: o.CustomerPurchaseOrderNumber ? String(o.CustomerPurchaseOrderNumber) : null,
        // Derived: "prepaid" = order marked Open but balance is 0 (fully paid, awaiting fulfilment)
        isPrepaid: num(o.BalanceDueAmount) === 0 && num(o.TotalAmount) > 0,
        // Age in days since order date
        ageDays: o.Date ? Math.floor((today.getTime() - new Date(o.Date).getTime()) / 86400000) : null,
      }))

      // ── Recently converted orders (last 30 days) ─────────────────────
      const convertedResult = await cdataQuery('JAWS', `
        SELECT Number, Date, CustomerName, TotalAmount, SalespersonName
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleOrders]
        WHERE Status = 'ConvertedToInvoice' AND Date >= '${d30Str}'
        ORDER BY Date DESC
      `)
      const convertedOrders = rowsToObjects(convertedResult).map(o => ({
        number: String(o.Number || ''),
        date: o.Date ? String(o.Date) : null,
        customerName: String(o.CustomerName || ''),
        totalAmount: num(o.TotalAmount),
        salespersonName: o.SalespersonName ? String(o.SalespersonName) : null,
      }))

      // ── Quotes (currently empty in JAWS but kept for future use) ─────
      const quotesResult = await cdataQuery('JAWS', `
        SELECT Number, Date, CustomerName, TotalAmount, SalespersonName
        FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleQuotes]
        ORDER BY Date DESC
      `)
      const quotes = rowsToObjects(quotesResult).map(q => ({
        number: String(q.Number || ''),
        date: q.Date ? String(q.Date) : null,
        customerName: String(q.CustomerName || ''),
        totalAmount: num(q.TotalAmount),
        salespersonName: q.SalespersonName ? String(q.SalespersonName) : null,
      }))

      // ── Totals ────────────────────────────────────────────────────────
      const openOrdersTotal = openOrders.reduce((s, o) => s + o.totalAmount, 0)
      const openOrdersOwing = openOrders.reduce((s, o) => s + o.balanceDueAmount, 0)
      const openOrdersPrepaid = openOrders.filter(o => o.isPrepaid).length
      const convertedTotal30d = convertedOrders.reduce((s, o) => s + o.totalAmount, 0)
      // Naive conversion rate: last 30d converted / (last 30d converted + currently open)
      // This is a rough indicator, not a true cohort analysis
      const conversionRate = (convertedOrders.length + openOrders.length) > 0
        ? convertedOrders.length / (convertedOrders.length + openOrders.length)
        : null

      res.status(200).json({
        openOrders,
        convertedOrders,
        quotes,
        totals: {
          openOrdersCount: openOrders.length,
          openOrdersTotal,
          openOrdersOwing,
          openOrdersPrepaid,
          convertedCount30d: convertedOrders.length,
          convertedTotal30d,
          quotesCount: quotes.length,
          quotesTotal: quotes.reduce((s, q) => s + q.totalAmount, 0),
          conversionRate,
        },
        meta: {
          company: 'JAWS',
          generatedAt: new Date().toISOString(),
          convertedWindow: '30 days',
        },
      })
    } catch (err: any) {
      console.error('quotes-orders api error:', err)
      res.status(500).json({ error: 'quotes_orders_failed', message: String(err?.message || err) })
    }
  })
}

// pages/api/quotes-orders.ts
// Returns JAWS quotes and orders — open orders, recently converted orders, and quotes.
// Quotes table is currently empty in MYOB but scaffolded for future use.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { fetchSaleOrders, fetchSaleQuotes } from '../../lib/myob-reporting'
import { invoiceExGst } from '../../lib/gst'

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

      // Direct MYOB OAuth (CData decommissioned 2026-07-14). Fetch all sale
      // orders/quotes once, filter by status client-side.
      const allOrders = await fetchSaleOrders('JAWS')
      const allQuotes = await fetchSaleQuotes('JAWS')

      // ── Open orders (pipeline — not yet invoiced/shipped) ────────────
      const openOrders = allOrders.filter(o => String(o.Status || '') === 'Open').map(o => {
        const total = num(o.TotalAmount)
        const tax = num(o.TotalTax)
        const balance = num(o.BalanceDueAmount)
        const balanceTaxRatio = total > 0 ? (tax * balance) / total : 0
        return {
          number: String(o.Number || ''),
          date: o.Date ? String(o.Date) : null,
          customerName: String(o.CustomerName || ''),
          customerDisplayId: o.CustomerDisplayID ? String(o.CustomerDisplayID) : null,
          totalAmount: total,
          totalAmountExGst: invoiceExGst(total, tax),
          balanceDueAmount: balance,
          balanceDueExGst: balance - balanceTaxRatio,
          status: String(o.Status || ''),
          subtotal: num(o.Subtotal),
          totalTax: tax,
          isTaxInclusive: o.IsTaxInclusive === true || o.IsTaxInclusive === 1,
          freight: num(o.Freight),
          salespersonName: o.SalespersonName ? String(o.SalespersonName) : null,
          customerPurchaseOrderNumber: o.CustomerPurchaseOrderNumber ? String(o.CustomerPurchaseOrderNumber) : null,
          isPrepaid: balance === 0 && total > 0,
          ageDays: o.Date ? Math.floor((today.getTime() - new Date(o.Date).getTime()) / 86400000) : null,
        }
      })

      // ── Recently converted orders (last 30 days) ─────────────────────
      const convertedOrders = allOrders
        .filter(o => String(o.Status || '') === 'ConvertedToInvoice' && o.Date && String(o.Date) >= d30Str)
        .map(o => {
        const total = num(o.TotalAmount)
        const tax = num(o.TotalTax)
        return {
          number: String(o.Number || ''),
          date: o.Date ? String(o.Date) : null,
          customerName: String(o.CustomerName || ''),
          totalAmount: total,
          totalAmountExGst: invoiceExGst(total, tax),
          salespersonName: o.SalespersonName ? String(o.SalespersonName) : null,
        }
      })

      // ── Quotes (currently empty in JAWS but kept for future use) ─────
      const quotes = allQuotes.map(q => {
        const total = num(q.TotalAmount)
        const tax = num(q.TotalTax)
        return {
          number: String(q.Number || ''),
          date: q.Date ? String(q.Date) : null,
          customerName: String(q.CustomerName || ''),
          totalAmount: total,
          totalAmountExGst: invoiceExGst(total, tax),
          salespersonName: q.SalespersonName ? String(q.SalespersonName) : null,
        }
      })

      // ── Totals ────────────────────────────────────────────────────────
      const openOrdersTotal = openOrders.reduce((s, o) => s + o.totalAmountExGst, 0)
      const openOrdersOwing = openOrders.reduce((s, o) => s + o.balanceDueExGst, 0)
      const openOrdersPrepaid = openOrders.filter(o => o.isPrepaid).length
      const convertedTotal30d = convertedOrders.reduce((s, o) => s + o.totalAmountExGst, 0)
      const conversionRate = (convertedOrders.length + openOrders.length) > 0
        ? convertedOrders.length / (convertedOrders.length + openOrders.length)
        : null

      res.status(200).json({
        amountsAreExGst: true,
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
          quotesTotal: quotes.reduce((s, q) => s + q.totalAmountExGst, 0),
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

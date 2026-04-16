// pages/api/distributors.ts – distributor sales for selected date range
import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery, parseDateRange } from '../../lib/cdata'

export const config = { maxDuration: 60 }

async function safe(fn: () => Promise<any>) {
    try { return await fn() } catch(e: any) { console.error('dist query failed:', e.message?.substring(0,80)); return null }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
    return requireAuth(req, res, async () => {
          try {
                  const { start, end } = parseDateRange(req)

            // Get distributor line items using MCP endpoint
            const lineItemsResult = await safe(() => cdataQuery('JAWS', `
                    SELECT i.[CustomerName], i.[Date], i.[AccountName], i.[AccountDisplayID],
                                   li.[Description], li.[Total], li.[ItemName]
                                           FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] i
                                                   INNER JOIN [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoiceItems] li ON i.[ID] = li.[SaleInvoiceId]
                                                           WHERE i.[Date] >= '${start}'
                                                                     AND i.[Date] <= '${end}'
                                                                               AND i.[TotalAmount] > 0
                                                                                       ORDER BY i.[Date] DESC
                                                                                             `))

            // Also get summary per customer for the period
            const summaryResult = await safe(() => cdataQuery('JAWS', `
                    SELECT [CustomerName],
                                   SUM([TotalAmount]) AS TotalRevenue,
                                                  COUNT(*) AS InvoiceCount
                                                          FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]
                                                                  WHERE [Date] >= '${start}'
                                                                            AND [Date] <= '${end}'
                                                                                      AND [TotalAmount] > 0
                                                                                              GROUP BY [CustomerName]
                                                                                                      ORDER BY TotalRevenue DESC
                                                                                                            `))

            res.status(200).json({
                      lineItems: lineItemsResult,
                      summary: summaryResult,
                      periodStart: start,
                      periodEnd: end,
            })
          } catch (err: any) {
                  console.error('distributors handler error:', err.message)
                  res.status(500).json({ error: err.message })
          }
    })
}

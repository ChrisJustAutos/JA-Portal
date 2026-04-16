import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const CDATA_USER = process.env.CDATA_USERNAME || ''
    const CDATA_PAT  = process.env.CDATA_PAT || ''
    const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
    
    const results: any = { user_set: !!CDATA_USER, pat_set: !!CDATA_PAT }

    // Try format 1: /api/sql (CData Connect Cloud SQL endpoint)
    try {
      const t1 = Date.now()
      const r1 = await fetch('https://cloud.cdata.com/api/sql', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionid: 'MYOB_POWERBI_JAWS', query: 'SELECT TOP 1 [Number] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]' }),
        cache: 'no-store',
      })
      results.format1 = { status: r1.status, ms: Date.now()-t1, body: (await r1.text()).substring(0, 200) }
    } catch(e: any) { results.format1 = { error: e.message } }

    // Try format 2: /api/odata4 (OData endpoint - tables as collections)  
    try {
      const t2 = Date.now()
      const r2 = await fetch('https://cloud.cdata.com/api/odata4/MYOB_POWERBI_JAWS/MYOB/SaleInvoices?$top=1&$select=Number,TotalAmount', {
        headers: { 'Authorization': `Basic ${creds}`, 'Accept': 'application/json' },
        cache: 'no-store',
      })
      results.format2 = { status: r2.status, ms: Date.now()-t2, body: (await r2.text()).substring(0, 200) }
    } catch(e: any) { results.format2 = { error: e.message } }

    // Try format 3: MCP server URL directly
    try {
      const t3 = Date.now()
      const r3 = await fetch('https://mcp.cloud.cdata.com/mcp', {
        method: 'POST',
        headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'queryData', arguments: { query: 'SELECT TOP 1 [Number] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices]' }}}),
        cache: 'no-store',
      })
      results.format3 = { status: r3.status, ms: Date.now()-t3, body: (await r3.text()).substring(0, 200) }
    } catch(e: any) { results.format3 = { error: e.message } }

    res.status(200).json(results)
  })
}

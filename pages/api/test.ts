import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const CDATA_USER = process.env.CDATA_USERNAME || ''
    const CDATA_PAT  = process.env.CDATA_PAT || ''
    const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
    
    const r = await fetch('https://mcp.cloud.cdata.com/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'queryData', arguments: { query: 'SELECT TOP 1 [Number],[TotalAmount] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC' } }
      }),
      cache: 'no-store',
    })
    
    const raw = await r.text()
    // Show raw SSE so we can parse it correctly
    res.status(200).json({ status: r.status, contentType: r.headers.get('content-type'), raw: raw.substring(0, 1000) })
  })
}

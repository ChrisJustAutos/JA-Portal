import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    const CDATA_BASE = process.env.CDATA_BASE_URL || ''
    const CDATA_USER = process.env.CDATA_USERNAME || ''
    const CDATA_PAT  = process.env.CDATA_PAT || ''
    
    const creds = Buffer.from(`${CDATA_USER}:${CDATA_PAT}`).toString('base64')
    
    try {
      const start = Date.now()
      const r = await fetch(`${CDATA_BASE}/MYOB_POWERBI_JAWS/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query: 'SELECT TOP 1 [Number],[TotalAmount] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC' }),
        cache: 'no-store',
      })
      const elapsed = Date.now() - start
      const text = await r.text()
      res.status(200).json({
        status: r.status,
        elapsed_ms: elapsed,
        cdata_base: CDATA_BASE,
        user_set: !!CDATA_USER,
        pat_set: !!CDATA_PAT,
        response_preview: text.substring(0, 500),
      })
    } catch (e: any) {
      res.status(200).json({ error: e.message, cdata_base: CDATA_BASE, user_set: !!CDATA_USER, pat_set: !!CDATA_PAT })
    }
  })
}

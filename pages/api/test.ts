import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth } from '../../lib/auth'
import { cdataQuery } from '../../lib/cdata'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      const result = await cdataQuery('JAWS', 
        'SELECT TOP 3 [Number],[TotalAmount],[CustomerName] FROM [MYOB_POWERBI_JAWS].[MYOB].[SaleInvoices] ORDER BY [Date] DESC'
      )
      res.status(200).json({ success: true, rows: result?.results?.[0]?.rows })
    } catch(e: any) {
      res.status(200).json({ success: false, error: e.message })
    }
  })
}

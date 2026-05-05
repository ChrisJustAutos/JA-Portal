// pages/api/myob/suppliers.ts
// Typeahead search for MYOB suppliers, used by the AP supplier preset picker.
// GET /api/myob/suppliers?q=repco&company=VPS&limit=20

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { searchSuppliers, CompanyFileLabel } from '../../../lib/ap-myob-lookup'

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const q = String(req.query.q || '').trim()
  const company = String(req.query.company || 'VPS').toUpperCase()
  if (company !== 'VPS' && company !== 'JAWS') {
    return res.status(400).json({ error: "company must be 'VPS' or 'JAWS'" })
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 50)

  try {
    const suppliers = await searchSuppliers(company as CompanyFileLabel, q, limit)
    return res.status(200).json({ suppliers, query: q, company })
  } catch (e: any) {
    console.error('MYOB supplier search failed:', e?.message)
    return res.status(502).json({ error: e?.message || 'MYOB lookup failed' })
  }
})

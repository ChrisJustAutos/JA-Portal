// pages/api/myob/accounts.ts
// Typeahead search for MYOB chart of accounts, used by the AP supplier preset
// picker. Defaults to Expense + CostOfSales (typical AP destinations).
//
// GET /api/myob/accounts?q=parts&company=VPS&limit=30
// GET /api/myob/accounts?q=&company=VPS&types=Expense,CostOfSales,OtherExpense

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { searchAccounts, CompanyFileLabel } from '../../../lib/ap-myob-lookup'

export default withAuth('view:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const q = String(req.query.q || '').trim()
  const company = String(req.query.company || 'VPS').toUpperCase()
  if (company !== 'VPS' && company !== 'JAWS') {
    return res.status(400).json({ error: "company must be 'VPS' or 'JAWS'" })
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '30'), 10), 1), 100)

  // types=Expense,CostOfSales (default) or types=all to skip the type filter
  const typesParam = String(req.query.types || 'Expense,CostOfSales').trim()
  const types = typesParam.toLowerCase() === 'all'
    ? []
    : typesParam.split(',').map(s => s.trim()).filter(Boolean)

  try {
    const accounts = await searchAccounts(company as CompanyFileLabel, q, limit, types)
    return res.status(200).json({ accounts, query: q, company, types })
  } catch (e: any) {
    console.error('MYOB account search failed:', e?.message)
    return res.status(502).json({ error: e?.message || 'MYOB lookup failed' })
  }
})

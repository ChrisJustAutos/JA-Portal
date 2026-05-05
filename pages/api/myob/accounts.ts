// pages/api/myob/accounts.ts
// Typeahead search for MYOB chart of accounts.
//
// **Default scope: ALL accounts (no type filter).** Callers that want only
// purchase-side accounts (Expense + CostOfSales) can pass
// `types=Expense,CostOfSales`. The all-by-default policy reflects real
// usage: a single AP invoice may want lines posted against asset, equity,
// or income accounts (e.g. capital purchases, refunds, owner draws), and
// forcing users through a "purchase only" filter created friction.
//
// GET /api/myob/accounts?q=parts&company=VPS&limit=30
// GET /api/myob/accounts?q=&company=JAWS&types=Expense,CostOfSales

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

  // Default 'all' (no type filter). Callers can opt into a subset by passing
  // `types=Expense,CostOfSales` etc. Passing `types=all` is also accepted as
  // an explicit no-filter signal.
  const typesParam = String(req.query.types || 'all').trim()
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

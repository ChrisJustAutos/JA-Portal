// pages/api/b2b/admin/myob/customers.ts
// GET /api/b2b/admin/myob/customers?q=foo
//
// Searches MYOB JAWS Customer cards for the distributor admin typeahead.
// Mirrors the supplier search pattern from lib/ap-myob-lookup.ts:
//   - Multi-token AND search across CompanyName, LastName, FirstName, DisplayID
//   - All fields wrapped in tolower() (substringof is case-sensitive in MYOB)
//   - Empty query returns first 20 customers ordered by CompanyName
//
// B2B is JAWS-only — VPS isn't relevant here.

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../../lib/myob'

interface MyobCustomerLite {
  uid: string
  display_id: string
  name: string
  is_individual: boolean
  is_active: boolean
  primary_email: string | null
  primary_phone: string | null
}

function escapeOData(s: string): string {
  return s.replace(/'/g, "''")
}

function mapCustomer(c: any): MyobCustomerLite {
  // For individuals MYOB stores FirstName + LastName separately;
  // CompanyName is empty. Build a sensible display name.
  const company = (c.CompanyName || '').trim()
  const first   = (c.FirstName || '').trim()
  const last    = (c.LastName  || '').trim()
  const name    = company || [first, last].filter(Boolean).join(' ') || '(unnamed)'

  return {
    uid:           c.UID || '',
    display_id:    c.DisplayID || '',
    name,
    is_individual: c.IsIndividual === true,
    is_active:     c.IsActive !== false,
    primary_email: c?.SellingDetails?.IsReportable != null ? null : null,  // not exposed on list endpoint
    primary_phone: null,
  }
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const q = String(req.query.q || '').trim()
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 50)

  try {
    const conn = await getConnection('JAWS')
    if (!conn) {
      return res.status(500).json({ error: 'JAWS MYOB connection not configured' })
    }

    const path = `/accountright/${conn.company_file_id}/Contact/Customer`
    const params: Record<string, string | number> = {
      '$top': limit,
      '$orderby': 'CompanyName',
    }

    const lowered = q.toLowerCase()
    if (lowered) {
      const tokens = lowered.split(/\s+/).filter(t => t.length > 0).slice(0, 3)
      if (tokens.length > 0) {
        const tokenClauses = tokens.map(tok => {
          const safe = escapeOData(tok)
          return (
            `(substringof('${safe}',tolower(CompanyName)) or ` +
            `substringof('${safe}',tolower(LastName)) or ` +
            `substringof('${safe}',tolower(FirstName)) or ` +
            `substringof('${safe}',tolower(DisplayID)))`
          )
        })
        // Active customers only
        params['$filter'] = `IsActive eq true and ` + tokenClauses.join(' and ')
      } else {
        params['$filter'] = `IsActive eq true`
      }
    } else {
      params['$filter'] = `IsActive eq true`
    }

    const result = await myobFetch(conn.id, path, { query: params })
    if (result.status !== 200) {
      return res.status(502).json({
        error: `MYOB customer search failed (HTTP ${result.status})`,
        detail: (result.raw || '').substring(0, 300),
      })
    }

    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    return res.status(200).json({ items: items.map(mapCustomer) })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }
})

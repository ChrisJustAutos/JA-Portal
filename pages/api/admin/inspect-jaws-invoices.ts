// pages/api/admin/inspect-jaws-invoices.ts
//
// One-off diagnostic endpoint to dump recent Sale.Invoice + CustomerPayment
// records from MYOB JAWS, so we can map the structure that the broken
// Stripe→MYOB Make automation was creating and replicate it in the
// backfill code.
//
// Auth: bearer CRON_SECRET (same as the cron endpoints).
//
// Usage:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://ja-portal.vercel.app/api/admin/inspect-jaws-invoices"
//
// Query params:
//   ?limit=10              max rows per category (default 5, max 25)
//   ?before=2026-04-16     only return records with Date < this ISO date
//                          (useful to see what Make produced before it broke)
//   ?subtype=Service|Item  invoice subtype (default Service — adjust if Make
//                          was creating Item invoices instead)
//   ?customer=Stripe       OData substring filter against Customer.Name
//                          (helps locate Make-created rows quickly)
//
// Returns raw JSON. Safe to delete after we've mapped the shape.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'

const ALLOWED_SUBTYPES = new Set(['Service', 'Item', 'Professional', 'TimeBilling', 'Miscellaneous'])

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  try {
    const conn = await getConnection('JAWS')
    if (!conn) return res.status(400).json({ error: 'No JAWS MYOB connection' })
    if (!conn.company_file_id) return res.status(400).json({ error: 'JAWS connection has no company file selected' })

    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10), 1), 25)
    const before = String(req.query.before || '').trim() || null
    const subtypeRaw = String(req.query.subtype || 'Service').trim()
    const subtype = ALLOWED_SUBTYPES.has(subtypeRaw) ? subtypeRaw : 'Service'
    const customer = String(req.query.customer || '').trim() || null

    const cfId = conn.company_file_id

    // OData filter — combine date + customer-name substring where given.
    const filters: string[] = []
    if (before) filters.push(`Date lt datetime'${before}T00:00:00'`)
    if (customer) {
      const safe = customer.replace(/'/g, "''").toLowerCase()
      filters.push(`substringof('${safe}', tolower(Customer/Name))`)
    }
    const filterStr = filters.length ? filters.join(' and ') : undefined

    // Build query objects
    const invQuery: Record<string, string | number> = {
      '$top': limit,
      '$orderby': 'Date desc',
    }
    if (filterStr) invQuery['$filter'] = filterStr

    // CustomerPayment doesn't have a Customer/Name navigation in the same
    // way — keep it simple: just date filter.
    const payQuery: Record<string, string | number> = {
      '$top': limit,
      '$orderby': 'Date desc',
    }
    if (before) payQuery['$filter'] = `Date lt datetime'${before}T00:00:00'`

    const [invRes, payRes] = await Promise.all([
      myobFetch(conn.id, `/accountright/${cfId}/Sale/Invoice/${subtype}`, { query: invQuery }),
      myobFetch(conn.id, `/accountright/${cfId}/Sale/CustomerPayment`, { query: payQuery }),
    ])

    return res.status(200).json({
      ok: true,
      companyFile: conn.company_file_name,
      params: { limit, before, subtype, customer },
      invoices: {
        endpoint: `/Sale/Invoice/${subtype}`,
        httpStatus: invRes.status,
        count: Array.isArray(invRes.data?.Items) ? invRes.data.Items.length : 0,
        items: invRes.data?.Items ?? invRes.data ?? null,
        hint: 'Look at one row created by Make: check Customer.Name, Lines[].Description, Lines[].Account.DisplayID, Lines[].TaxCode.Code, Memo, Comment, JournalMemo.',
      },
      payments: {
        endpoint: '/Sale/CustomerPayment',
        httpStatus: payRes.status,
        count: Array.isArray(payRes.data?.Items) ? payRes.data.Items.length : 0,
        items: payRes.data?.Items ?? payRes.data ?? null,
        hint: 'Check DepositTo (which bank account / undeposited funds), Account.DisplayID, Invoices[].UID linkage, Amount, Memo.',
      },
    })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

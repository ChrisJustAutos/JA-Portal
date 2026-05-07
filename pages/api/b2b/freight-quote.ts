// pages/api/b2b/freight-quote.ts
// Distributor-facing rate lookup. Called from the cart when the user
// picks (or changes) a shipping address — returns the available rates
// for that postcode as a list the UI renders as radio options.
//
//   GET /api/b2b/freight-quote?postcode=4000
//     → { quote: { zone, rates[] } | null }
//
// Returns 200 with { quote: null } when no zone matches — the UI shows
// "No rate configured for this postcode — contact us for a quote".

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../lib/authServer'
import { getFreightQuote } from '../../../lib/b2b-freight'

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const postcode = String(req.query.postcode || '').trim()
  if (!postcode) return res.status(400).json({ error: 'postcode required' })

  try {
    const quote = await getFreightQuote(postcode)
    return res.status(200).json({ quote, postcode })
  } catch (e: any) {
    console.error('freight-quote failed:', e?.message)
    return res.status(500).json({ error: e?.message || 'freight-quote failed' })
  }
})

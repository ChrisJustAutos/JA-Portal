// pages/api/admin/inspect-bank-feed.ts
//
// Probe MYOB's bank-feed endpoints to see what's there for CHQ 1-1110.
// Used to design the bank-feed-based payouts sync.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  try {
    const conn = await getConnection('JAWS')
    if (!conn?.company_file_id) return res.status(400).json({ error: 'JAWS connection not configured' })
    const cfId = conn.company_file_id

    const paths = [
      '/Banking/BankFeedTransaction',
      '/Banking/BankFeedAccount',
      '/Banking/BankFeed',
      '/Banking/BankAccountTransaction',
      '/Banking/UnallocatedBankFeedTransaction',
    ]

    const results: any[] = []
    for (const path of paths) {
      try {
        const { status, data, raw } = await myobFetch(conn.id, `/accountright/${cfId}${path}`, {
          query: { '$top': 3 },
        })
        results.push({
          path,
          status,
          itemCount: Array.isArray(data?.Items) ? data.Items.length : null,
          firstItem: Array.isArray(data?.Items) && data.Items[0] ? Object.keys(data.Items[0]) : null,
          rawSnippet: raw?.slice(0, 400),
        })
      } catch (e: any) {
        results.push({ path, error: (e?.message || String(e)).slice(0, 200) })
      }
    }
    return res.status(200).json({ ok: true, results })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

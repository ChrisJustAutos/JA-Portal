// pages/api/admin/inspect-jaws-account.ts
//
// Quick diagnostic — fetches a MYOB JAWS GL account by DisplayID and
// returns its UID + metadata. Used to resolve account UIDs we hard-code
// in lib/stripe-payout-sync.ts (CHQ bank account, etc).
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://ja-portal.vercel.app/api/admin/inspect-jaws-account?displayId=1-1110"

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const displayId = String(req.query.displayId || '').trim()
  const name = String(req.query.name || '').trim()
  if (!displayId && !name) {
    return res.status(400).json({ error: 'displayId or name required' })
  }

  try {
    const conn = await getConnection('JAWS')
    if (!conn?.company_file_id) return res.status(400).json({ error: 'JAWS connection not configured' })
    const cfId = conn.company_file_id

    const filters: string[] = []
    if (displayId) filters.push(`DisplayID eq '${displayId.replace(/'/g, "''")}'`)
    if (name)      filters.push(`substringof('${name.toLowerCase().replace(/'/g, "''")}', tolower(Name))`)
    const filter = filters.join(' or ')

    const { status, data } = await myobFetch(conn.id, `/accountright/${cfId}/GeneralLedger/Account`, {
      query: { '$top': 10, '$filter': filter },
    })
    if (status !== 200) {
      return res.status(502).json({ error: `MYOB HTTP ${status}` })
    }
    const items: any[] = Array.isArray(data?.Items) ? data.Items : []
    return res.status(200).json({
      ok: true,
      count: items.length,
      accounts: items.map(a => ({
        uid: a.UID,
        displayId: a.DisplayID,
        name: a.Name,
        type: a.Type,
        bankingDetails: a.BankingDetails || null,
        isActive: a.IsActive,
      })),
    })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

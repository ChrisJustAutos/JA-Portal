// pages/api/admin/delete-myob-transfer.ts
//
// One-off: delete a MYOB TransferMoneyTxn by UID. Used to clean up
// the wrong-shape transfer that the first payout reconcile created
// before we knew Prepare Bank Deposit was the correct pattern.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const uid = String(req.query.uid || '').trim()
  if (!uid) return res.status(400).json({ error: 'uid required' })

  try {
    const conn = await getConnection('JAWS')
    if (!conn?.company_file_id) return res.status(400).json({ error: 'JAWS connection not configured' })

    const path = `/accountright/${conn.company_file_id}/Banking/TransferMoneyTxn/${uid}`
    const { status, raw } = await myobFetch(conn.id, path, { method: 'DELETE' })
    return res.status(200).json({
      ok: status >= 200 && status < 300,
      myobStatus: status,
      myobBody: raw?.slice(0, 500),
    })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

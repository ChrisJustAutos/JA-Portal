// pages/api/admin/push-myob-credit-note.ts
//
// Create a negative Service invoice (credit note) in MYOB JAWS.
// One-off admin tool for refunds that don't flow through the normal
// Stripe sync (e.g. Make-era refunds being backfilled, or manual
// adjustments).
//
// Body:
//   customerUid       string                 (required)
//   amountDollars     number > 0             (required — will be stored negative)
//   description       string                 (required — appears on the line)
//   accountUid        string                 (required — income/cost account UID)
//   journalMemo?      string                 (optional)
//   dateIso?          'YYYY-MM-DD'           (optional — defaults to today)

import type { NextApiRequest, NextApiResponse } from 'next'
import { getConnection, myobFetch } from '../../../lib/myob'
import { JAWS_UIDS } from '../../../lib/stripe-myob-sync'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body = (req.body || {}) as Record<string, any>
  const customerUid = String(body.customerUid || '').trim()
  const amountDollars = Number(body.amountDollars)
  const description = String(body.description || '').trim()
  const accountUid = String(body.accountUid || '').trim()
  const journalMemo = body.journalMemo ? String(body.journalMemo) : ''
  const dateIso = body.dateIso ? String(body.dateIso) : new Date().toISOString().slice(0, 10)

  if (!customerUid) return res.status(400).json({ error: 'customerUid required' })
  if (!isFinite(amountDollars) || amountDollars <= 0) {
    return res.status(400).json({ error: 'amountDollars must be a positive number' })
  }
  if (!description) return res.status(400).json({ error: 'description required' })
  if (!accountUid) return res.status(400).json({ error: 'accountUid required' })

  try {
    const conn = await getConnection('JAWS')
    if (!conn?.company_file_id) return res.status(400).json({ error: 'JAWS connection not configured' })
    const cfId = conn.company_file_id

    const payload = {
      Date: dateIso + 'T00:00:00',
      Customer: { UID: customerUid },
      Lines: [{
        Type: 'Transaction',
        Description: description,
        Total: -amountDollars,
        Account: { UID: accountUid },
        TaxCode: { UID: JAWS_UIDS.TAX_CODE_GST },
      }],
      IsTaxInclusive: true,
      Comment: '',
      JournalMemo: journalMemo || `Credit ${description}`,
      Terms: { PaymentIsDue: 'DayOfMonthAfterEOM', DiscountDate: 1, BalanceDueDate: 30 },
    }

    const result = await myobFetch(conn.id, `/accountright/${cfId}/Sale/Invoice/Service`, {
      method: 'POST', body: payload, query: { returnBody: 'true' },
    })
    if (result.status !== 200 && result.status !== 201) {
      return res.status(502).json({
        ok: false,
        myobStatus: result.status,
        error: result.raw?.slice(0, 500),
        payload,
      })
    }

    return res.status(200).json({
      ok: true,
      myobInvoice: {
        uid: result.data?.UID,
        number: result.data?.Number,
        total: result.data?.TotalAmount,
        customer: result.data?.Customer?.Name,
      },
      payload,
    })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 500) })
  }
}

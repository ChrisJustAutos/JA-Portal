// pages/api/stripe-myob/payouts-sync.ts
//
// Scan MYOB CHQ 1-1110 for existing bank-deposit transactions that
// match Stripe payouts in the window. Catches Make-era reconciled
// payouts (or anything done manually in MYOB UI) so they don't keep
// showing as Pending in our Payouts tab.
//
// Match strategy per payout:
//   1. Search MYOB Banking endpoints (ReceiveMoneyTxn, TransferMoneyTxn,
//      and the broader BankAccount filter) for transactions on the CHQ
//      account within ±3 days of payout.arrival_date.
//   2. Filter in JS for exact amount match (within $0.01).
//   3. Bonus weighting: if the memo/description contains 'STRIPE' or
//      the payout id substring, prefer that match (helps disambiguate
//      same-amount, same-date transactions from non-Stripe deposits).
//
// If unique match → mark sync_log row 'skipped_duplicate' with note.
// If multiple or zero → leave Pending for manual review.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPayouts,
} from '../../../lib/stripe-multi'
import { JAWS_UIDS } from '../../../lib/stripe-myob-sync'
import { getConnection, myobFetch } from '../../../lib/myob'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function parseUnixDay(s: string, endOfDay = false): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const ms = Date.parse(s + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'))
  if (!isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

interface CandidateTxn {
  source: 'receive' | 'transfer' | 'spend'
  uid: string
  date: string
  amount: number          // dollars; positive for receive/transfer-into-CHQ, negative for spend
  memo: string
  hasStripeMention: boolean
}

async function listChqTxnsInWindow(
  connId: string,
  cfId: string,
  isoFrom: string,
  isoTo: string,
): Promise<CandidateTxn[]> {
  const filterDate = `Date ge datetime'${isoFrom}T00:00:00' and Date le datetime'${isoTo}T23:59:59'`
  const chqUid = JAWS_UIDS.ACCT_CHQ_3369

  const receiveQ = `Account/UID eq guid'${chqUid}' and ${filterDate}`
  const transferQ = `(FromAccount/UID eq guid'${chqUid}' or ToAccount/UID eq guid'${chqUid}') and ${filterDate}`
  const spendQ = `Account/UID eq guid'${chqUid}' and ${filterDate}`

  const out: CandidateTxn[] = []

  const tryFetch = async (
    source: CandidateTxn['source'],
    path: string,
    query: string,
    amountKey: string,
  ) => {
    try {
      const { status, data } = await myobFetch(connId, `/accountright/${cfId}/Banking/${path}`, {
        query: { '$top': 200, '$filter': query },
      })
      if (status !== 200) return
      const items: any[] = Array.isArray(data?.Items) ? data.Items : []
      for (const it of items) {
        const amt = typeof it[amountKey] === 'number'
          ? it[amountKey]
          : parseFloat(it[amountKey] || '0')
        const memo = String(it.Memo || it.JournalMemo || '').trim()
        let signedAmt = amt
        if (source === 'transfer') {
          // Transfers can move money out of CHQ (negative effect) — flip sign accordingly.
          signedAmt = it.ToAccount?.UID === chqUid ? amt : -amt
        }
        if (source === 'spend') signedAmt = -amt
        out.push({
          source,
          uid: it.UID,
          date: String(it.Date || '').slice(0, 10),
          amount: signedAmt,
          memo,
          hasStripeMention: /stripe|pyout|po_|payout/i.test(memo),
        })
      }
    } catch { /* keep going */ }
  }

  await tryFetch('receive',  'ReceiveMoneyTxn',  receiveQ,  'TotalReceived')
  await tryFetch('transfer', 'TransferMoneyTxn', transferQ, 'Amount')
  await tryFetch('spend',    'SpendMoneyTxn',    spendQ,    'TotalSpent')

  return out
}

async function authorize(req: NextApiRequest): Promise<{ ok: true; performedBy: string | null } | { ok: false; status: number; error: string }> {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true, performedBy: 'cron' }
  const user = await getCurrentUser(req)
  if (!user) return { ok: false, status: 401, error: 'Unauthenticated' }
  if (!roleHasPermission(user.role, 'edit:stripe_myob')) {
    return { ok: false, status: 403, error: 'Forbidden — edit:stripe_myob required' }
  }
  return { ok: true, performedBy: user.email }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body = (req.body || {}) as Record<string, any>
  const account = String(body.account || '').trim() as StripeAccountLabel
  if (!STRIPE_ACCOUNT_LABELS.includes(account)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }

  const sinceStr = String(body.since || '').trim()
  const untilStr = String(body.until || '').trim()
  const since = parseUnixDay(sinceStr, false)
  if (!since) return res.status(400).json({ error: 'since must be YYYY-MM-DD' })
  const until = untilStr ? parseUnixDay(untilStr, true) : Math.floor(Date.now() / 1000)
  if (!until) return res.status(400).json({ error: 'until must be YYYY-MM-DD' })

  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) return res.status(400).json({ error: 'No JAWS MYOB connection / company file' })
  const cfId = conn.company_file_id

  const payouts = await listPayouts(account, since, until)

  const ids = payouts.map(p => p.id)
  const { data: existing } = await sb()
    .from('stripe_myob_sync_log')
    .select('stripe_entity_id, status')
    .eq('stripe_account', account)
    .eq('stripe_entity_type', 'payout')
    .in('stripe_entity_id', ids.length ? ids : ['none'])
  const alreadyHandled = new Set(
    (existing || []).filter((r: any) => r.status === 'pushed' || r.status === 'skipped_duplicate').map((r: any) => r.stripe_entity_id),
  )
  const toScan = payouts.filter(p => !alreadyHandled.has(p.id))

  const results: Array<{
    payoutId: string
    arrival_date: string
    amount: number
    matched: boolean
    matchSource?: 'receive' | 'transfer' | 'spend'
    matchUid?: string
    matchMemo?: string
    candidateCount?: number
  }> = []
  let matchedCount = 0

  for (const p of toScan) {
    const amountDollars = p.amount / 100
    const arrival = new Date(p.arrival_date * 1000)
    const isoFrom = new Date(arrival.getTime() - 3 * 86400_000).toISOString().slice(0, 10)
    const isoTo   = new Date(arrival.getTime() + 3 * 86400_000).toISOString().slice(0, 10)

    try {
      const candidates = await listChqTxnsInWindow(conn.id, cfId, isoFrom, isoTo)
      const amountMatches = candidates.filter(c => Math.abs(c.amount - amountDollars) < 0.01)

      // Prefer Stripe-mentioning matches if any exist.
      const stripeMentioned = amountMatches.filter(c => c.hasStripeMention)
      const finalMatches = stripeMentioned.length > 0 ? stripeMentioned : amountMatches

      if (finalMatches.length === 1) {
        const m = finalMatches[0]
        await sb().from('stripe_myob_sync_log').upsert({
          stripe_account: account,
          stripe_entity_type: 'payout',
          stripe_entity_id: p.id,
          myob_company_file: 'JAWS',
          status: 'skipped_duplicate',
          amount_cents: p.amount,
          last_error: null,
          raw_payload: { matched: { source: m.source, uid: m.uid, date: m.date, memo: m.memo } },
          created_by: auth.performedBy || 'system',
        }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })
        matchedCount++
        results.push({
          payoutId: p.id,
          arrival_date: isoFrom,
          amount: amountDollars,
          matched: true,
          matchSource: m.source,
          matchUid: m.uid,
          matchMemo: m.memo,
          candidateCount: amountMatches.length,
        })
      } else {
        results.push({
          payoutId: p.id,
          arrival_date: isoFrom,
          amount: amountDollars,
          matched: false,
          candidateCount: amountMatches.length,
        })
      }
    } catch (e: any) {
      results.push({
        payoutId: p.id,
        arrival_date: isoFrom,
        amount: amountDollars,
        matched: false,
      })
    }
  }

  return res.status(200).json({
    ok: true,
    account,
    summary: {
      scanned: toScan.length,
      matched: matchedCount,
      unmatched: toScan.length - matchedCount,
      skippedAlreadyHandled: alreadyHandled.size,
    },
    results,
  })
}

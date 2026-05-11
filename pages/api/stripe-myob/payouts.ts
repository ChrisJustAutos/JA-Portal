// pages/api/stripe-myob/payouts.ts
//
// List Stripe payouts in a date range, joined with the sync log so
// each row carries its MYOB reconcile status. Backs the Payouts tab
// on /stripe-myob.
//
// Auth: CRON_SECRET bearer OR portal session with view:stripe_myob.
//
//   GET /api/stripe-myob/payouts?account=JAWS_JMACX&since=2026-04-01
//
// Query:
//   ?account=JAWS_JMACX | JAWS_ET   (required)
//   ?since=YYYY-MM-DD                (required — based on arrival_date)
//   ?until=YYYY-MM-DD                (optional — defaults to now)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPayouts,
} from '../../../lib/stripe-multi'
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

async function authorize(req: NextApiRequest): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true }
  const user = await getCurrentUser(req)
  if (!user) return { ok: false, status: 401, error: 'Unauthenticated' }
  if (!roleHasPermission(user.role, 'view:stripe_myob')) {
    return { ok: false, status: 403, error: 'Forbidden — view:stripe_myob required' }
  }
  return { ok: true }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await authorize(req)
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

  const accountParam = String(req.query.account || '').trim()
  if (!STRIPE_ACCOUNT_LABELS.includes(accountParam as StripeAccountLabel)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }
  const account = accountParam as StripeAccountLabel

  const sinceStr = String(req.query.since || '').trim()
  const untilStr = String(req.query.until || '').trim()
  const since = parseUnixDay(sinceStr, false)
  if (!since) return res.status(400).json({ error: 'since must be YYYY-MM-DD' })
  const until = untilStr ? parseUnixDay(untilStr, true) : Math.floor(Date.now() / 1000)
  if (!until) return res.status(400).json({ error: 'until must be YYYY-MM-DD' })

  try {
    const payouts = await listPayouts(account, since, until)

    let logByPayoutId = new Map<string, any>()
    if (payouts.length > 0) {
      const { data: logRows } = await sb()
        .from('stripe_myob_sync_log')
        .select('stripe_entity_id, status, myob_invoice_uid, myob_payment_uid, amount_cents, fee_cents, last_error, pushed_at, raw_payload')
        .eq('stripe_account', account)
        .eq('stripe_entity_type', 'payout')
        .in('stripe_entity_id', payouts.map(p => p.id))
      logByPayoutId = new Map((logRows || []).map(r => [r.stripe_entity_id, r]))
    }

    const slim = payouts.map(p => {
      const log = logByPayoutId.get(p.id)
      return {
        id: p.id,
        amount_cents: p.amount,
        currency: p.currency,
        status: p.status,
        arrival_date: new Date(p.arrival_date * 1000).toISOString(),
        created: new Date(p.created * 1000).toISOString(),
        description: p.description,
        method: p.method,
        statement_descriptor: p.statement_descriptor,
        balance_transaction: p.balance_transaction,
        // sync state
        myobStatus: log?.status || 'pending',
        myobFeeCents: log?.fee_cents ?? null,
        myobTransferUid: log?.myob_invoice_uid || null,
        myobFeePaymentUid: log?.myob_payment_uid || null,
        lastError: log?.last_error || null,
        pushedAt: log?.pushed_at || null,
        breakdown: log?.raw_payload?.breakdown || null,
      }
    })

    const summary = {
      total: slim.length,
      pushed:   slim.filter(p => p.myobStatus === 'pushed').length,
      pending:  slim.filter(p => p.myobStatus === 'pending').length,
      failed:   slim.filter(p => p.myobStatus === 'failed').length,
    }

    return res.status(200).json({
      ok: true,
      account,
      since: new Date(since * 1000).toISOString(),
      until: new Date(until * 1000).toISOString(),
      summary,
      payouts: slim,
    })
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: (e?.message || String(e)).slice(0, 500),
    })
  }
}

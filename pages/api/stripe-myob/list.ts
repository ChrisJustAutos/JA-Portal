// pages/api/stripe-myob/list.ts
//
// Returns Stripe invoices for a connected account + date range, joined
// with the local sync log so each row carries its MYOB push status.
// This is what backs the Portal /stripe-myob page.
//
// Auth: either CRON_SECRET bearer (for backfill scripts) OR portal
// session with `view:stripe_myob`.
//
// Usage:
//   GET /api/stripe-myob/list?account=JAWS_JMACX&since=2026-04-16
//
// Query params:
//   ?account=JAWS_JMACX | JAWS_ET   (required)
//   ?since=YYYY-MM-DD                (required — inclusive)
//   ?until=YYYY-MM-DD                (optional — defaults to now)
//   ?kind=invoices | charges | refunds | all   (default 'invoices')

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPaidInvoices,
  listCharges,
  listRefunds,
  pingAccount,
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
  // CRON_SECRET — used by backfill scripts/curl
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) return { ok: true }

  // Portal session
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

  const kindRaw = String(req.query.kind || 'invoices').trim().toLowerCase()
  const kind = ['invoices', 'charges', 'refunds', 'all'].includes(kindRaw) ? kindRaw : 'invoices'

  try {
    const acct = await pingAccount(account).catch(e => ({ error: e?.message || String(e) }))

    const wantInvoices = kind === 'invoices' || kind === 'all'
    const wantCharges  = kind === 'charges'  || kind === 'all'
    const wantRefunds  = kind === 'refunds'  || kind === 'all'

    const [invoices, charges, refunds] = await Promise.all([
      wantInvoices ? listPaidInvoices(account, since, until) : Promise.resolve([]),
      wantCharges  ? listCharges(account, since, until)      : Promise.resolve([]),
      wantRefunds  ? listRefunds(account, since, until)      : Promise.resolve([]),
    ])

    // Pull sync log entries for these Stripe ids in one round-trip.
    const allIds = [
      ...invoices.map(i => i.id),
      ...charges.map(c => c.id),
      ...refunds.map(r => r.id),
    ]
    let logByEntityId = new Map<string, any>()
    if (allIds.length > 0) {
      const { data: logRows } = await sb()
        .from('stripe_myob_sync_log')
        .select('stripe_entity_id, status, myob_invoice_uid, myob_invoice_number:myob_invoice_uid, myob_payment_uid, myob_customer_uid, amount_cents, fee_cents, net_cents, last_error, pushed_at, attempts')
        .eq('stripe_account', account)
        .in('stripe_entity_id', allIds)
      // Note: we re-fetch the MYOB invoice Number lazily later if needed.
      logByEntityId = new Map((logRows || []).map(r => [r.stripe_entity_id, r]))
    }

    const slimInvoices = invoices.map(inv => {
      const log = logByEntityId.get(inv.id)
      return {
        id: inv.id,
        number: inv.number,
        status: inv.status,
        paid: inv.paid,
        created: new Date(inv.created * 1000).toISOString(),
        paid_at: inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
          : null,
        customer: inv.customer,
        customer_email: inv.customer_email,
        customer_name: inv.customer_name,
        total_cents: inv.total,
        currency: inv.currency,
        description: inv.description,
        metadata: inv.metadata,
        lines: (inv.lines?.data || []).map(ln => ({
          id: ln.id,
          amount_cents: ln.amount,
          description: ln.description,
          quantity: ln.quantity,
        })),
        // MYOB sync state
        myobStatus: log?.status || 'pending',     // pending | pushed | failed | skipped_duplicate
        myobInvoiceUid: log?.myob_invoice_uid || null,
        myobPaymentUid: log?.myob_payment_uid || null,
        myobCustomerUid: log?.myob_customer_uid || null,
        myobFeeCents: log?.fee_cents ?? null,
        myobNetCents: log?.net_cents ?? null,
        lastError: log?.last_error || null,
        pushedAt: log?.pushed_at || null,
        attempts: log?.attempts ?? 0,
      }
    })

    const summary = {
      total: slimInvoices.length,
      pushed:   slimInvoices.filter(i => i.myobStatus === 'pushed').length,
      pending:  slimInvoices.filter(i => i.myobStatus === 'pending').length,
      failed:   slimInvoices.filter(i => i.myobStatus === 'failed').length,
      duplicate: slimInvoices.filter(i => i.myobStatus === 'skipped_duplicate').length,
    }

    return res.status(200).json({
      ok: true,
      account,
      since: new Date(since * 1000).toISOString(),
      until: new Date(until * 1000).toISOString(),
      stripeAccount: acct,
      summary,
      counts: {
        invoices: slimInvoices.length,
        charges: charges.length,
        refunds: refunds.length,
      },
      invoices: slimInvoices,
    })
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: (e?.message || String(e)).slice(0, 500),
    })
  }
}

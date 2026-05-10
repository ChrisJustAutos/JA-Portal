// pages/api/stripe-myob/list.ts
//
// Stage 1 of the Stripe→MYOB JAWS backfill: read-only listing of Stripe
// invoices, charges and refunds for a given connected account + date
// range. NO writes to MYOB — this is the data-source for the Portal
// page and the backfill tool. Once we're confident the data looks
// right we'll add a /push companion endpoint.
//
// Auth: CRON_SECRET bearer.
//
// Usage:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://ja-portal.vercel.app/api/stripe-myob/list?account=JAWS_JMACX&since=2026-04-16"
//
// Query params:
//   ?account=JAWS_JMACX | JAWS_ET   (required)
//   ?since=YYYY-MM-DD                (required — inclusive)
//   ?until=YYYY-MM-DD                (optional — defaults to now)
//   ?kind=invoices | charges | refunds | all   (default 'invoices')

import type { NextApiRequest, NextApiResponse } from 'next'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPaidInvoices,
  listCharges,
  listRefunds,
  pingAccount,
} from '../../../lib/stripe-multi'

function parseUnixDay(s: string, endOfDay = false): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const ms = Date.parse(s + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'))
  if (!isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorised' })
  }

  const accountParam = String(req.query.account || '').trim()
  if (!STRIPE_ACCOUNT_LABELS.includes(accountParam as StripeAccountLabel)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }
  const account = accountParam as StripeAccountLabel

  const sinceStr = String(req.query.since || '').trim()
  const untilStr = String(req.query.until || '').trim()
  const since = parseUnixDay(sinceStr, false)
  if (!since) return res.status(400).json({ error: 'since must be YYYY-MM-DD' })
  const until = untilStr
    ? parseUnixDay(untilStr, true)
    : Math.floor(Date.now() / 1000)
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

    // Trim invoice payloads for response — full list of invoice lines bloats
    // the JSON. Keep enough for the user to verify what we'd push.
    const slimInvoices = invoices.map(inv => ({
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
      charge: inv.charge,
      payment_intent: inv.payment_intent,
      description: inv.description,
      metadata: inv.metadata,
      lines: (inv.lines?.data || []).map(ln => ({
        id: ln.id,
        amount_cents: ln.amount,
        description: ln.description,
        quantity: ln.quantity,
      })),
    }))

    const slimCharges = charges.map(c => ({
      id: c.id,
      amount_cents: c.amount,
      amount_refunded_cents: c.amount_refunded,
      currency: c.currency,
      status: c.status,
      paid: c.paid,
      refunded: c.refunded,
      created: new Date(c.created * 1000).toISOString(),
      customer: c.customer,
      invoice: c.invoice,
      payment_intent: c.payment_intent,
      balance_transaction: c.balance_transaction,
      description: c.description,
      receipt_email: c.receipt_email,
      billing_details: c.billing_details,
      metadata: c.metadata,
    }))

    const slimRefunds = refunds.map(r => ({
      id: r.id,
      amount_cents: r.amount,
      currency: r.currency,
      status: r.status,
      reason: r.reason,
      charge: r.charge,
      payment_intent: r.payment_intent,
      balance_transaction: r.balance_transaction,
      created: new Date(r.created * 1000).toISOString(),
      metadata: r.metadata,
    }))

    return res.status(200).json({
      ok: true,
      account,
      since: new Date(since * 1000).toISOString(),
      until: new Date(until * 1000).toISOString(),
      stripeAccount: acct,
      counts: {
        invoices: slimInvoices.length,
        charges: slimCharges.length,
        refunds: slimRefunds.length,
      },
      invoices: slimInvoices,
      charges:  slimCharges,
      refunds:  slimRefunds,
    })
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: (e?.message || String(e)).slice(0, 500),
    })
  }
}

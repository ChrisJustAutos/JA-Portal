// pages/api/stripe-myob/push.ts
//
// Push Stripe invoice(s) to MYOB JAWS. Defaults to dry-run; the caller
// must pass dry=0 explicitly to actually write to MYOB.
//
// Auth: CRON_SECRET bearer (will switch to portal auth once the UI lands).
//
// Usage:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//        -H "Content-Type: application/json" \
//        -d '{"account":"JAWS_JMACX","stripeInvoiceIds":["in_..."]}' \
//        "https://ja-portal.vercel.app/api/stripe-myob/push?dry=1"
//
// Body:
//   account            'JAWS_JMACX' | 'JAWS_ET'   (required)
//   stripeInvoiceIds   string[]                   (required, max 50)
//   customerOverrideUid?  string                  per-call MYOB customer override
//   saleAccountUid?       string                  override default sale account
//
// Query:
//   dry=1 (default) | dry=0   force-real

import type { NextApiRequest, NextApiResponse } from 'next'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPaidInvoices,
} from '../../../lib/stripe-multi'
import { pushStripeInvoiceToJaws } from '../../../lib/stripe-myob-sync'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: either CRON_SECRET bearer (scripts) or portal session with edit:stripe_myob (UI)
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.authorization || ''
  let performedBy: string | null = null

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    performedBy = 'cron'
  } else {
    const user = await getCurrentUser(req)
    if (!user) return res.status(401).json({ error: 'Unauthenticated' })
    if (!roleHasPermission(user.role, 'edit:stripe_myob')) {
      return res.status(403).json({ error: 'Forbidden — edit:stripe_myob required' })
    }
    performedBy = user.email
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  // Default to dry-run unless explicitly disabled.
  const dryRun = req.query.dry !== '0'

  const body = (req.body || {}) as Record<string, any>
  const account = String(body.account || '').trim() as StripeAccountLabel
  if (!STRIPE_ACCOUNT_LABELS.includes(account)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }

  const ids: string[] = Array.isArray(body.stripeInvoiceIds)
    ? body.stripeInvoiceIds.filter((s: any) => typeof s === 'string').slice(0, 50)
    : []
  if (ids.length === 0) {
    return res.status(400).json({ error: 'stripeInvoiceIds must be a non-empty string array' })
  }

  const customerOverrideUid: string | undefined =
    typeof body.customerOverrideUid === 'string' ? body.customerOverrideUid : undefined
  const saleAccountUid: string | undefined =
    typeof body.saleAccountUid === 'string' ? body.saleAccountUid : undefined

  // We need the full invoice objects from Stripe to push. The list endpoint
  // pulls a window of invoices — refetch within a generous date window
  // (covers the original 16/4 backfill plus future bulk calls).
  const now = Math.floor(Date.now() / 1000)
  const sixMonthsAgo = now - 60 * 60 * 24 * 180
  const allInvoices = await listPaidInvoices(account, sixMonthsAgo, now)
  const byId = new Map(allInvoices.map(inv => [inv.id, inv]))

  const results = []
  for (const id of ids) {
    const inv = byId.get(id)
    if (!inv) {
      results.push({
        stripeInvoiceId: id,
        error: 'invoice not found in Stripe (or outside the 180-day window)',
      })
      continue
    }
    try {
      const r = await pushStripeInvoiceToJaws(account, inv, {
        dryRun,
        performedBy,
        customerOverrideUid,
        saleAccountUid,
      })
      results.push(r)
    } catch (e: any) {
      results.push({
        stripeInvoiceId: id,
        error: (e?.message || String(e)).slice(0, 500),
      })
    }
  }

  return res.status(200).json({
    ok: true,
    account,
    dryRun,
    count: results.length,
    results,
  })
}

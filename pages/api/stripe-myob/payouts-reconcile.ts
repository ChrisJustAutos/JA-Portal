// pages/api/stripe-myob/payouts-reconcile.ts
//
// Reconcile one or many Stripe payouts to MYOB JAWS. Dry-run default.
//
// Auth: CRON_SECRET bearer OR portal session with edit:stripe_myob.
//
// Body:
//   account            'JAWS_JMACX' | 'JAWS_ET'   (required)
//   payoutIds          string[]                   (required, max 25)
//
// Query:
//   dry=1 (default) | dry=0

import type { NextApiRequest, NextApiResponse } from 'next'
import { STRIPE_ACCOUNT_LABELS, StripeAccountLabel } from '../../../lib/stripe-multi'
import { reconcileStripePayoutToJaws } from '../../../lib/stripe-payout-sync'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

  const dryRun = req.query.dry !== '0'

  const body = (req.body || {}) as Record<string, any>
  const account = String(body.account || '').trim() as StripeAccountLabel
  if (!STRIPE_ACCOUNT_LABELS.includes(account)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }

  const ids: string[] = Array.isArray(body.payoutIds)
    ? body.payoutIds.filter((s: any) => typeof s === 'string').slice(0, 25)
    : []
  if (ids.length === 0) {
    return res.status(400).json({ error: 'payoutIds must be a non-empty string array' })
  }

  const results: any[] = []
  for (const id of ids) {
    try {
      const r = await reconcileStripePayoutToJaws(account, id, { dryRun, performedBy })
      results.push(r)
    } catch (e: any) {
      results.push({ payoutId: id, error: (e?.message || String(e)).slice(0, 500) })
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

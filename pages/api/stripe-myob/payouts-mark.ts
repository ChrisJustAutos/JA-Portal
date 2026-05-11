// pages/api/stripe-myob/payouts-mark.ts
//
// Manually flag a Stripe payout as already reconciled in MYOB UI.
// Use when you know the payout was deposited in MYOB (via the bank
// rec or Prepare Bank Deposit feature) but the API can't see it.
//
// Body:
//   account            'JAWS_JMACX' | 'JAWS_ET'
//   payoutId           string (required)
//   note?              string (optional — recorded on the sync log)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { STRIPE_ACCOUNT_LABELS, StripeAccountLabel } from '../../../lib/stripe-multi'
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

  const body = (req.body || {}) as Record<string, any>
  const account = String(body.account || '').trim() as StripeAccountLabel
  if (!STRIPE_ACCOUNT_LABELS.includes(account)) {
    return res.status(400).json({ error: `account must be one of ${STRIPE_ACCOUNT_LABELS.join(', ')}` })
  }
  const payoutId = String(body.payoutId || '').trim()
  if (!payoutId) return res.status(400).json({ error: 'payoutId required' })
  const note = body.note ? String(body.note).slice(0, 300) : `manually marked reconciled by ${performedBy || 'system'}`

  const { error } = await sb().from('stripe_myob_sync_log').upsert({
    stripe_account: account,
    stripe_entity_type: 'payout',
    stripe_entity_id: payoutId,
    myob_company_file: 'JAWS',
    status: 'skipped_duplicate',
    last_error: null,
    raw_payload: { manuallyMarked: { reason: note, at: new Date().toISOString(), by: performedBy } },
    created_by: performedBy || 'system',
  }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true, payoutId, status: 'skipped_duplicate', note })
}

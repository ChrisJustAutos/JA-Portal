// pages/api/stripe-myob/sync.ts
//
// Scan MYOB JAWS for invoices that match Stripe invoices in a date
// range, and update the sync log so the UI reflects what's actually
// in MYOB. Use this to reconcile records the Make automation created
// before its freeze (or anything else that landed in MYOB outside
// this tool).
//
// No MYOB writes happen — read-only on the MYOB side, only the local
// sync_log gets upserted.
//
// Auth: CRON_SECRET bearer OR portal session with edit:stripe_myob
// (since updating the log changes what shows as 'Pending' in the UI).
//
// Body:
//   account            'JAWS_JMACX' | 'JAWS_ET'   (required)
//   since              'YYYY-MM-DD'               (required)
//   until?             'YYYY-MM-DD'               (default today)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  STRIPE_ACCOUNT_LABELS,
  StripeAccountLabel,
  listPaidInvoices,
} from '../../../lib/stripe-multi'
import {
  findMyobMatchForStripeIds,
  findMyobMatchByCustomerAmountDate,
} from '../../../lib/stripe-myob-sync'
import { getConnection } from '../../../lib/myob'
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth
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

  const sinceStr = String(body.since || '').trim()
  const untilStr = String(body.until || '').trim()
  const since = parseUnixDay(sinceStr, false)
  if (!since) return res.status(400).json({ error: 'since must be YYYY-MM-DD' })
  const until = untilStr ? parseUnixDay(untilStr, true) : Math.floor(Date.now() / 1000)
  if (!until) return res.status(400).json({ error: 'until must be YYYY-MM-DD' })

  // Get the JAWS MYOB connection (target file is hardcoded — both Stripe
  // accounts feed into the same MYOB JAWS file).
  const conn = await getConnection('JAWS')
  if (!conn) return res.status(400).json({ error: 'No JAWS MYOB connection' })
  if (!conn.company_file_id) return res.status(400).json({ error: 'JAWS connection has no company file selected' })
  const cfId = conn.company_file_id

  // Pull Stripe invoices in range.
  const invoices = await listPaidInvoices(account, since, until)

  // Skip ones already marked as pushed/skipped_duplicate in our log.
  const ids = invoices.map(i => i.id)
  const { data: existing } = await sb()
    .from('stripe_myob_sync_log')
    .select('stripe_entity_id, status')
    .eq('stripe_account', account)
    .in('stripe_entity_id', ids.length ? ids : ['none'])
  const alreadyHandled = new Set(
    (existing || [])
      .filter((r: any) => r.status === 'pushed' || r.status === 'skipped_duplicate')
      .map((r: any) => r.stripe_entity_id),
  )

  const toScan = invoices.filter(i => !alreadyHandled.has(i.id))

  const results: Array<{
    stripeInvoiceId: string
    stripeNumber: string | null
    matched: boolean
    matchMethod?: 'stripe-id' | 'customer-amount-date'
    matchedStripeId?: string
    matchReason?: string
    myobInvoiceUid?: string
    myobInvoiceNumber?: string
    error?: string
  }> = []

  let matchedCount = 0
  for (const inv of toScan) {
    try {
      // 1. ID-based search — Stripe ids in MYOB JournalMemo.
      const stripeIds: string[] = [inv.id]
      for (const ln of (inv.lines?.data || [])) {
        if (ln.id) stripeIds.push(ln.id)
        if (ln.invoice_item) stripeIds.push(ln.invoice_item)
      }
      let hit = await findMyobMatchForStripeIds(conn.id, cfId, stripeIds)
      let method: 'stripe-id' | 'customer-amount-date' = 'stripe-id'
      let matchedStripeId = hit?.matchedStripeId
      let matchReason: string | undefined = hit ? `JournalMemo contains ${hit.matchedStripeId}` : undefined

      // 2. Fuzzy fallback — customer name + same dollar amount + ±3 days.
      if (!hit) {
        const paidIso = (inv.status_transitions?.paid_at
          ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
          : new Date(inv.created * 1000).toISOString()).slice(0, 10)
        const fuzzy = await findMyobMatchByCustomerAmountDate(conn.id, cfId, {
          customerName: inv.customer_name || '',
          grossDollars: inv.total / 100,
          isoDate: paidIso,
        })
        if (fuzzy) {
          hit = { uid: fuzzy.uid, number: fuzzy.number, matchedStripeId: '(fuzzy)' }
          method = 'customer-amount-date'
          matchReason = `${fuzzy.reason} (fuzzy)`
        }
      }

      if (hit) {
        matchedCount++
        await sb().from('stripe_myob_sync_log').upsert({
          stripe_account: account,
          stripe_entity_type: 'invoice',
          stripe_entity_id: inv.id,
          myob_company_file: 'JAWS',
          myob_invoice_uid: hit.uid,
          status: 'skipped_duplicate',
          amount_cents: inv.total,
          customer_email: inv.customer_email,
          customer_name: inv.customer_name,
          last_error: null,
          raw_payload: { matched: { method, reason: matchReason, myobNumber: hit.number } },
          created_by: performedBy || 'system',
        }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })
        results.push({
          stripeInvoiceId: inv.id,
          stripeNumber: inv.number,
          matched: true,
          matchMethod: method,
          matchedStripeId,
          matchReason,
          myobInvoiceUid: hit.uid,
          myobInvoiceNumber: hit.number,
        })
      } else {
        results.push({
          stripeInvoiceId: inv.id,
          stripeNumber: inv.number,
          matched: false,
        })
      }
    } catch (e: any) {
      results.push({
        stripeInvoiceId: inv.id,
        stripeNumber: inv.number,
        matched: false,
        error: (e?.message || String(e)).slice(0, 300),
      })
    }
  }

  return res.status(200).json({
    ok: true,
    account,
    since: new Date(since * 1000).toISOString(),
    until: new Date(until * 1000).toISOString(),
    summary: {
      scanned: toScan.length,
      matched: matchedCount,
      unmatched: toScan.length - matchedCount,
      skippedAlreadyHandled: alreadyHandled.size,
    },
    results,
  })
}

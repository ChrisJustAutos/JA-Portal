// pages/api/ap/admin/automation.ts
//
// Service-role endpoint for automated AP push (Claude / mobile shortcut /
// cron). Bearer-auth via AP_AUTOMATION_API_KEY env var — bypasses the
// portal user session intentionally so it can be called when the user
// isn't at a desk.
//
// GET  /api/ap/admin/automation
//   → { invoices: [...green+unposted...] }
//   Useful as a preview before posting.
//
// POST /api/ap/admin/automation
//   body: { action: 'push', ids?: string[], dry_run?: boolean }
//   - ids omitted = push every eligible invoice
//   - ids provided = filter to those, then re-check eligibility server-side
//     (a non-eligible id is silently skipped, not pushed)
//   - dry_run = true → returns what WOULD be pushed without firing
//
// Eligibility (enforced server-side, regardless of what the caller passes):
//   triage_status = 'green'
//   AND status != 'posted'
//   AND myob_bill_uid IS NULL
//
// Audit:
//   - myob_posted_by is set to a fixed sentinel UUID so these rows are
//     identifiable in logs / DB queries.
//   - Each push attempt and result is console.log'd (visible in Vercel
//     runtime logs).
//
// IMPORTANT: this endpoint can create real MYOB bills. Treat the API key
// like any other production secret. Rotate via Vercel env vars.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { checkBearer } from '../../../../lib/api-key-auth'
import { createServiceBill } from '../../../../lib/ap-myob-bill'

// Synthetic actor — distinguishable from any real user in audit queries.
const AUTOMATION_ACTOR_UUID = '00000000-0000-0000-0000-000000000a01'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface EligibleRow {
  id: string
  vendor_name_parsed: string | null
  resolved_supplier_name: string | null
  invoice_number: string | null
  invoice_date: string | null
  total_inc_gst: string | number | null
  status: string | null
  triage_status: string | null
  myob_bill_uid: string | null
}

async function fetchEligible(c: SupabaseClient): Promise<EligibleRow[]> {
  const { data, error } = await c
    .from('ap_invoices')
    .select(`
      id, vendor_name_parsed, resolved_supplier_name,
      invoice_number, invoice_date, total_inc_gst,
      status, triage_status, myob_bill_uid
    `)
    .eq('triage_status', 'green')
    .neq('status', 'posted')
    .is('myob_bill_uid', null)
    .order('invoice_date', { ascending: true, nullsFirst: false })
  if (error) throw new Error(error.message)
  return (data || []) as EligibleRow[]
}

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = checkBearer(req, 'AP_AUTOMATION_API_KEY')
  if (!auth.ok) {
    return res.status(401).json({ error: auth.reason || 'Unauthorized' })
  }

  if (req.method === 'GET') {
    try {
      const eligible = await fetchEligible(sb())
      return res.status(200).json({
        count: eligible.length,
        invoices: eligible.map(i => ({
          id: i.id,
          supplier: i.resolved_supplier_name || i.vendor_name_parsed || '(unknown)',
          invoice_number: i.invoice_number,
          invoice_date: i.invoice_date,
          total_inc_gst: i.total_inc_gst != null ? Number(i.total_inc_gst) : null,
        })),
      })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) })
    }
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const action = String(body.action || '').trim()

    if (action !== 'push') {
      return res.status(400).json({ error: `Unknown action "${action}". Supported: push.` })
    }

    const requestedIds = Array.isArray(body.ids) ? body.ids.filter((x: any) => typeof x === 'string') as string[] : null
    const dryRun = body.dry_run === true

    let eligible: EligibleRow[]
    try {
      eligible = await fetchEligible(sb())
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) })
    }

    const targets = requestedIds && requestedIds.length > 0
      ? eligible.filter(i => requestedIds.includes(i.id))
      : eligible
    const skippedIds = requestedIds
      ? requestedIds.filter(id => !targets.find(t => t.id === id))
      : []

    if (dryRun) {
      console.log(`[ap-automation] dry-run: would push ${targets.length} invoice(s)`)
      return res.status(200).json({
        dry_run: true,
        would_push: targets.map(i => ({
          id: i.id,
          supplier: i.resolved_supplier_name || i.vendor_name_parsed,
          invoice_number: i.invoice_number,
          total_inc_gst: i.total_inc_gst != null ? Number(i.total_inc_gst) : null,
        })),
        skipped_ineligible: skippedIds,
      })
    }

    const pushed: { id: string; supplier: string | null; invoice_number: string | null; bill_uid: string }[] = []
    const errors: { id: string; supplier: string | null; invoice_number: string | null; error: string }[] = []

    for (const inv of targets) {
      try {
        const r = await createServiceBill(inv.id, AUTOMATION_ACTOR_UUID)
        pushed.push({
          id: inv.id,
          supplier: inv.resolved_supplier_name || inv.vendor_name_parsed,
          invoice_number: inv.invoice_number,
          bill_uid: r.myobBillUid,
        })
        console.log(`[ap-automation] pushed ${inv.id} (${inv.invoice_number}) → MYOB bill ${r.myobBillUid}`)
      } catch (e: any) {
        const msg = e?.message || String(e)
        errors.push({
          id: inv.id,
          supplier: inv.resolved_supplier_name || inv.vendor_name_parsed,
          invoice_number: inv.invoice_number,
          error: msg,
        })
        console.error(`[ap-automation] push failed for ${inv.id}: ${msg}`)
      }
    }

    return res.status(200).json({
      pushed_count:  pushed.length,
      error_count:   errors.length,
      skipped_ineligible: skippedIds,
      pushed,
      errors,
    })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

// pages/api/ap/[id]/link-job.ts
// Manually link or unlink an AP invoice to/from a workshop job.
//
//   POST body:  { jobNumber: "20019-1" }   → set the link (manual)
//   POST body:  { jobNumber: null }        → clear the link, re-run triage
//
// After updating the link the row's triage is recomputed so the YELLOW
// po-no-job-match flag clears (or returns) accordingly.
//
// May 2026 — PO auto-fill on manual link:
//   When the user manually picks a job and the invoice's po_number is
//   currently null/empty, we copy the job_number into po_number. Common
//   case: invoices like the Fatz/Mitch Duff one where the workshop never
//   wrote the job # into the PO field, so auto-link missed it. Auto-
//   filling closes the loop — future re-triage will then auto-link via
//   PO instead of relying on the manual_method flag, and the PO field
//   becomes a useful audit trail. We never overwrite an existing PO —
//   a different non-matching value might be a legitimate vendor reference
//   the user wants to keep.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyTriageAndResolve } from '../../../../lib/ap-supabase'
import { getJobByNumber, writeJobLink } from '../../../../lib/ap-job-link'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' })
  }

  const body = (req.body || {}) as { jobNumber?: string | null }
  const jobNumberInput = body.jobNumber

  // Confirm invoice exists. Pull po_number too so we know whether to
  // auto-fill on link.
  const c = sb()
  const { data: inv, error: invErr } = await c
    .from('ap_invoices')
    .select('id, status, po_number')
    .eq('id', id)
    .maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv) return res.status(404).json({ error: 'Invoice not found' })

  if (inv.status === 'posted') {
    return res.status(409).json({ error: 'Cannot change job link on a posted invoice' })
  }

  // Unlink path
  if (jobNumberInput === null || jobNumberInput === undefined || jobNumberInput === '') {
    await writeJobLink(id, null, 'manual', 'no-po-on-invoice', user.id)
    // Re-run triage — auto-link will run again from PO and may relink/unlink
    try { await applyTriageAndResolve(id) } catch (e: any) {
      console.error('triage after unlink failed:', e?.message)
    }
    return res.status(200).json({ ok: true, action: 'unlinked' })
  }

  // Link path — confirm the job exists
  const jobNumber = String(jobNumberInput).trim()
  const job = await getJobByNumber(jobNumber)
  if (!job) {
    return res.status(404).json({ error: `Job ${jobNumber} not found in latest workshop snapshot` })
  }

  // Auto-fill PO from job number when the invoice has no PO yet. Done
  // BEFORE writeJobLink + applyTriageAndResolve so the subsequent triage
  // sees the new PO and runs auto-link cleanly.
  let poAutoFilled = false
  const existingPo = (inv.po_number || '').toString().trim()
  if (!existingPo) {
    const { error: poErr } = await c
      .from('ap_invoices')
      .update({ po_number: job.job_number })
      .eq('id', id)
    if (poErr) {
      console.error(`link-job: po auto-fill failed for ${id}: ${poErr.message}`)
    } else {
      poAutoFilled = true
    }
  }

  await writeJobLink(id, job.job_number, 'manual', 'matched', user.id)

  // Re-run triage so YELLOW:po-no-job-match clears if it was set, and so
  // the auto-fill PO above gets reflected in re-resolved fields.
  try { await applyTriageAndResolve(id) } catch (e: any) {
    console.error('triage after manual link failed:', e?.message)
  }

  return res.status(200).json({
    ok: true,
    action: 'linked',
    poAutoFilled,
    job: {
      job_number: job.job_number,
      customer_name: job.customer_name,
      vehicle: job.vehicle,
      status: job.status,
    },
  })
})

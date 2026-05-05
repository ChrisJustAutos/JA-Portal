// pages/api/ap/[id]/link-job.ts
// Manually link or unlink an AP invoice to/from a workshop job.
//
//   POST body:  { jobNumber: "20019-1" }   → set the link (manual)
//   POST body:  { jobNumber: null }        → clear the link, re-run triage
//
// After updating the link the row's triage is recomputed so the YELLOW
// po-no-job-match flag clears (or returns) accordingly.

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

  // Confirm invoice exists
  const c = sb()
  const { data: inv, error: invErr } = await c
    .from('ap_invoices')
    .select('id, status')
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

  await writeJobLink(id, job.job_number, 'manual', 'matched', user.id)

  // Re-run triage so YELLOW:po-no-job-match clears if it was set
  try { await applyTriageAndResolve(id) } catch (e: any) {
    console.error('triage after manual link failed:', e?.message)
  }

  return res.status(200).json({
    ok: true,
    action: 'linked',
    job: {
      job_number: job.job_number,
      customer_name: job.customer_name,
      vehicle: job.vehicle,
      status: job.status,
    },
  })
})

// pages/api/b2b/jobs.ts
// Distributor-facing tune jobs.
//   GET  → { jobs } — this distributor's tune jobs (open first), each with a
//          short-lived signed URL for the Stripe invoice PDF when stored.
//   POST { job_id, details:{...} } → submit the customer/job details
//          (fires Monday + letter; MechanicDesk follows via the worker).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'
import { submitTuneJobDetails, TuneJobDetails, tuneJobVisible } from '../../../lib/b2b-tune-jobs'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  const c = sb()

  if (req.method === 'GET') {
    // All of this distributor's jobs, paged (Penrith 4x4 already carries 81 —
    // a flat cap would silently hide the oldest). Invoice links signed in
    // batches of 100 rather than one storage call per row.
    const jobs: any[] = []
    for (let from = 0; from < 5000; from += 1000) {
      const { data, error } = await c.from('b2b_tune_jobs')
        .select(`
          id, status, vin, tune_details, invoice_number, amount, email_received_at, created_at,
          invoice_pdf_path, customer_name, customer_first_name, customer_phone, customer_email,
          customer_address_line1, customer_suburb, customer_state, customer_postcode,
          vehicle_rego, vehicle_make, vehicle_model, vehicle_year, vehicle_description, job_notes, filled_at
        `)
        .eq('distributor_id', user.distributor.id)
        .in('status', ['awaiting_details', 'submitted', 'synced'])
        .order('created_at', { ascending: false })
        .range(from, from + 999)
      if (error) return res.status(500).json({ error: error.message })
      jobs.push(...(data || []))
      if (!data || data.length < 1000) break
    }

    // Portal-visibility delay: a fresh tune only appears N days (default 3)
    // after its receipt arrived. Admin sees everything immediately.
    const visible = jobs.filter(j => tuneJobVisible(j))
    jobs.length = 0
    jobs.push(...visible)

    const paths = Array.from(new Set(jobs.map(j => j.invoice_pdf_path).filter(Boolean))) as string[]
    const urlByPath = new Map<string, string>()
    for (let i = 0; i < paths.length; i += 100) {
      const { data: signed } = await c.storage.from('b2b-tune-invoices')
        .createSignedUrls(paths.slice(i, i + 100), 3600)
      for (const s of signed || []) {
        if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl)
      }
    }

    const out = jobs.map(j => {
      const { invoice_pdf_path: p, ...rest } = j as any
      return { ...rest, invoice_url: p ? urlByPath.get(p) || null : null }
    })
    return res.status(200).json({ jobs: out })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const jobId = String(body.job_id || '').trim()
    if (!jobId) return res.status(400).json({ error: 'job_id required' })
    try {
      await submitTuneJobDetails(jobId, user.distributor.id, user.id, (body.details || {}) as TuneJobDetails)
      return res.status(200).json({ ok: true })
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Submit failed' })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

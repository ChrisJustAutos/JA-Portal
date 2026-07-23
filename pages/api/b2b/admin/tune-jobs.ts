// pages/api/b2b/admin/tune-jobs.ts
// Staff-side tune-job management.
//   GET  → { jobs, distributors } — all jobs (unmatched first) + active
//          distributors for assignment; each job gets a signed invoice URL.
//   POST { action, ... }:
//     assign      { job_id, distributor_id, save_alias } — match + optional sticky alias
//     dismiss     { job_id }                             — not a real tune job
//     retry_sync  { job_id }                             — re-fire Monday/letter
//     remind_now  {}                                     — send reminders immediately
//     ingest_now  {}                                     — scan the inbox now
//
// Permission: edit:b2b_distributors (same tier as the rest of B2B admin).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { assignTuneJobDistributor, syncTuneJobDownstream, sendTuneJobReminders, ingestTuneJobEmails } from '../../../../lib/b2b-tune-jobs'

export const config = { maxDuration: 300 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    const { data: jobs, error } = await c.from('b2b_tune_jobs')
      .select('*, distributor:b2b_distributors!b2b_tune_jobs_distributor_id_fkey(display_name)')
      .order('created_at', { ascending: false })
      .limit(300)
    if (error) return res.status(500).json({ error: error.message })
    const { data: dists } = await c.from('b2b_distributors')
      .select('id, display_name').eq('is_active', true).order('display_name')

    const out = []
    for (const j of jobs || []) {
      let invoiceUrl: string | null = null
      if (j.invoice_pdf_path) {
        const { data: signed } = await c.storage.from('b2b-tune-invoices').createSignedUrl(j.invoice_pdf_path, 3600)
        invoiceUrl = signed?.signedUrl || null
      }
      out.push({ ...j, invoice_url: invoiceUrl, distributor_name: (Array.isArray(j.distributor) ? j.distributor[0] : j.distributor)?.display_name || null })
    }
    return res.status(200).json({ jobs: out, distributors: dists || [] })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const action = String(body.action || '')
    try {
      if (action === 'assign') {
        if (!body.job_id || !body.distributor_id) return res.status(400).json({ error: 'job_id + distributor_id required' })
        await assignTuneJobDistributor(String(body.job_id), String(body.distributor_id), body.save_alias !== false)
        return res.status(200).json({ ok: true })
      }
      if (action === 'dismiss') {
        if (!body.job_id) return res.status(400).json({ error: 'job_id required' })
        await c.from('b2b_tune_jobs').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', String(body.job_id))
        return res.status(200).json({ ok: true })
      }
      if (action === 'retry_sync') {
        if (!body.job_id) return res.status(400).json({ error: 'job_id required' })
        await syncTuneJobDownstream(String(body.job_id))
        return res.status(200).json({ ok: true })
      }
      if (action === 'remind_now') {
        const r = await sendTuneJobReminders()
        return res.status(200).json({ ok: true, ...r })
      }
      if (action === 'ingest_now') {
        const r = await ingestTuneJobEmails({ lookbackDays: Number(body.lookback_days) || 14 })
        return res.status(200).json({ ok: true, ...r })
      }
      return res.status(400).json({ error: `Unknown action "${action}"` })
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) })
    }
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

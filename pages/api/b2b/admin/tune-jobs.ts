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
import { assignTuneJobDistributor, dismissTuneJob, syncTuneJobDownstream, sendTuneJobReminders, sendTuneJobRecap, ingestTuneJobEmails, adminEditTuneJob } from '../../../../lib/b2b-tune-jobs'

export const config = { maxDuration: 300 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  const c = sb()

  if (req.method === 'GET') {
    // ALL jobs, paged — a flat .limit(300) hid everything older than the
    // newest 300 rows, so distributor counts undercounted (Penrith 4x4
    // showed 56 of its 81, Chris 2026-07-28). extraction jsonb excluded —
    // the admin page never reads it and it dominates payload size.
    const jobs: any[] = []
    for (let from = 0; from < 10_000; from += 1000) {
      const { data, error } = await c.from('b2b_tune_jobs')
        .select(`
          id, internet_message_id, email_subject, email_from, email_received_at,
          invoice_pdf_path, invoice_number, amount, company_raw, distributor_id,
          vin, tune_details, status, customer_name, customer_first_name,
          customer_phone, customer_email, customer_address_line1, customer_suburb,
          customer_state, customer_postcode, vehicle_rego, vehicle_make,
          vehicle_model, vehicle_year, vehicle_description, job_notes,
          filled_by_user_id, filled_at, monday_item_id, md_customer_md_id,
          md_synced_at, md_resync_pending, admin_edited_at,
          letter_job_id, letter_queued_at, sync_error, synced_at,
          last_reminder_at, first_reminded_at, sms_reminded_at, escalated_at,
          created_at, updated_at,
          distributor:b2b_distributors!b2b_tune_jobs_distributor_id_fkey(display_name)
        `)
        // 'merged' rows are receipts folded into a same-VIN primary job (the
        // primary carries the combined tune/invoice/amount) — showing them
        // made one tune look like two (Chris 2026-08-11).
        .neq('status', 'merged')
        .order('created_at', { ascending: false })
        .range(from, from + 999)
      if (error) return res.status(500).json({ error: error.message })
      jobs.push(...(data || []))
      if (!data || data.length < 1000) break
    }
    const { data: dists } = await c.from('b2b_distributors')
      .select('id, display_name').eq('is_active', true).order('display_name')

    // Invoice links signed in batches — one storage call per 100 paths
    // instead of one per row (474 sequential calls was the reason for the cap).
    const paths = Array.from(new Set(jobs.map(j => j.invoice_pdf_path).filter(Boolean))) as string[]
    const urlByPath = new Map<string, string>()
    for (let i = 0; i < paths.length; i += 100) {
      const { data: signed } = await c.storage.from('b2b-tune-invoices')
        .createSignedUrls(paths.slice(i, i + 100), 3600)
      for (const s of signed || []) {
        if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl)
      }
    }

    const out = jobs.map(j => ({
      ...j,
      invoice_url: j.invoice_pdf_path ? urlByPath.get(j.invoice_pdf_path) || null : null,
      distributor_name: (Array.isArray(j.distributor) ? j.distributor[0] : j.distributor)?.display_name || null,
    }))
    return res.status(200).json({ jobs: out, distributors: dists || [] })
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
    const action = String(body.action || '')
    try {
      if (action === 'assign') {
        if (!body.job_id || !body.distributor_id) return res.status(400).json({ error: 'job_id + distributor_id required' })
        const r = await assignTuneJobDistributor(String(body.job_id), String(body.distributor_id), body.save_alias !== false)
        return res.status(200).json({ ok: true, matched_jobs: r.matchedJobs })
      }
      if (action === 'dismiss') {
        if (!body.job_id) return res.status(400).json({ error: 'job_id required' })
        const r = await dismissTuneJob(String(body.job_id))
        return res.status(200).json({ ok: true, dismissed_jobs: r.dismissedJobs, excluded_name: r.excludedName })
      }
      if (action === 'edit_details') {
        // Staff correction of a distributor's submission (Chris 2026-08-14):
        // saves the fixed fields, re-pushes the Monday follow-up item now,
        // and queues an MD correction for the nightly worker when the job
        // already has an MD customer.
        if (!body.job_id || !body.fields) return res.status(400).json({ error: 'job_id + fields required' })
        const r = await adminEditTuneJob(String(body.job_id), body.fields)
        return res.status(200).json({ ok: true, ...r })
      }
      if (action === 'retry_sync') {
        if (!body.job_id) return res.status(400).json({ error: 'job_id required' })
        await syncTuneJobDownstream(String(body.job_id))
        return res.status(200).json({ ok: true })
      }
      if (action === 'remind_now') {
        // This button is the catch-up when the weekly run is missed, so it has
        // to produce BOTH halves of that run - it used to chase distributors
        // and leave Matt with no recap, which is how a skipped Friday went
        // unnoticed until someone asked (Chris, 2026-08-31).
        const r = await sendTuneJobReminders()
        const recap = await sendTuneJobRecap(r).catch(e => {
          console.error('tune-job recap (manual) failed:', e?.message || e)
          return null
        })
        return res.status(200).json({
          ok: true, ...r,
          recap_sent: !!recap?.sent,
          recap_rows: recap?.rows ?? null,
          message: `Chased ${r.jobs} job${r.jobs === 1 ? '' : 's'} across ${r.distributors} distributor${r.distributors === 1 ? '' : 's'}.`
            + (recap?.sent ? ' Recap emailed.' : ' Recap FAILED to send — check the logs.'),
        })
      }
      if (action === 'create_test_job') {
        // Self-contained MD-import test: a fabricated job under an internal
        // "ZZ Portal Test" distributor (inactive — invisible to real B2B
        // flows), returned with its fill link so made-up customer details can
        // be entered and pushed through the full MechanicDesk pipeline.
        let { data: testDist } = await c.from('b2b_distributors')
          .select('id').eq('display_name', 'ZZ Portal Test').maybeSingle()
        if (!testDist) {
          const { data: created, error: cErr } = await c.from('b2b_distributors')
            .insert({ display_name: 'ZZ Portal Test', is_active: false, myob_primary_customer_uid: '00000000-0000-0000-0000-000000000000' })
            .select('id').single()
          if (cErr) return res.status(500).json({ error: `test distributor create failed: ${cErr.message}` })
          testDist = created
        }
        const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')
        const { data: job, error: jErr } = await c.from('b2b_tune_jobs').insert({
          company_raw: 'JA PORTAL TEST',
          distributor_id: testDist!.id,
          vin: 'JTETEST0000000001',
          tune_details: 'TEST — MD import check (delete me in MD)',
          invoice_number: `TEST-${stamp}`,
          amount: 0,
          status: 'awaiting_details',
        }).select('id').single()
        if (jErr) return res.status(500).json({ error: jErr.message })
        const { signOrderAction } = await import('../../../../lib/order-action-token')
        const token = signOrderAction({ orderId: String(testDist!.id), scope: 'tune_jobs', ttlDays: 2 })
        return res.status(200).json({ ok: true, job_id: job.id, url: `https://justautos.app/tune-jobs?token=${encodeURIComponent(token)}` })
      }
      if (action === 'delete_test_jobs') {
        // Hard-delete everything created via the "Create test job" tool
        // (company_raw 'JA PORTAL TEST') — real ingested jobs are untouched.
        const { data: gone, error: delErr } = await c.from('b2b_tune_jobs')
          .delete().eq('company_raw', 'JA PORTAL TEST').select('id')
        if (delErr) return res.status(500).json({ error: delErr.message })
        return res.status(200).json({ ok: true, deleted: (gone || []).length })
      }
      if (action === 'preview_link') {
        // Login-less READ-ONLY preview of a distributor's portal (for Scribe
        // docs / demos). Lands on /b2b/preview which sets the preview cookie;
        // every mutation is blocked server-side. 1-day token.
        if (!body.distributor_id) return res.status(400).json({ error: 'distributor_id required' })
        const { ensurePreviewUser } = await import('../../../../lib/b2bAuthServer')
        await ensurePreviewUser(String(body.distributor_id))  // so the demo cart works
        const { signOrderAction } = await import('../../../../lib/order-action-token')
        const token = signOrderAction({ orderId: String(body.distributor_id), scope: 'b2b_preview' as any, ttlDays: 1 })
        return res.status(200).json({ ok: true, url: `https://justautos.app/b2b/preview?token=${encodeURIComponent(token)}` })
      }
      if (action === 'fill_link') {
        // Mint the same login-less fill link the reminder email carries —
        // for testing or resending to a distributor out-of-band.
        if (!body.distributor_id) return res.status(400).json({ error: 'distributor_id required' })
        const { signOrderAction } = await import('../../../../lib/order-action-token')
        const token = signOrderAction({ orderId: String(body.distributor_id), scope: 'tune_jobs', ttlDays: 14 })
        return res.status(200).json({ ok: true, url: `https://justautos.app/tune-jobs?token=${encodeURIComponent(token)}` })
      }
      if (action === 'ingest_now') {
        const sinceIso = body.since ? new Date(String(body.since)).toISOString() : undefined
        const untilIso = body.until ? new Date(String(body.until)).toISOString() : undefined
        const r = await ingestTuneJobEmails({ lookbackDays: Number(body.lookback_days) || 14, sinceIso, untilIso })
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

// pages/api/workshop/oncar/ingest.ts
// Service-token endpoint the MechanicDesk "parts on cars" worker POSTs to.
//   POST { action: 'start',  run_id?, requested_by? }  → { run_id } (status 'running')
//   POST { action: 'finish', run_id, result }          → marks 'done' + stores the snapshot
//   POST { action: 'error',  run_id, error }           → marks 'error'
// Auth: X-Service-Token with the stocktake:write scope (same token the other
// MechanicDesk workers use).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../lib/service-auth'

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '8mb' } } }

function sb(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const num = (v: any) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v))

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Unauthorised — service token required' })

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  const db = sb()
  const action = String(body.action || '')

  if (action === 'start') {
    // The refresh endpoint pre-creates a pending row so the screen can show a
    // spinner during the ~60-90s Actions spin-up; adopt it rather than
    // inserting a duplicate.
    const existingId = String(body.run_id || '')
    if (existingId) {
      const { data, error } = await db.from('md_oncar_runs')
        .update({ status: 'running' }).eq('id', existingId).select('id').maybeSingle()
      if (error) return res.status(500).json({ error: error.message })
      if (data) return res.status(200).json({ run_id: data.id })
    }
    const { data, error } = await db.from('md_oncar_runs')
      .insert({ status: 'running', requested_by: String(body.requested_by || 'worker').slice(0, 120) })
      .select('id').single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ run_id: data.id })
  }

  const runId = String(body.run_id || '')
  if (!runId) return res.status(400).json({ error: 'run_id required' })

  if (action === 'error') {
    await db.from('md_oncar_runs')
      .update({ status: 'error', error: String(body.error || 'unknown').slice(0, 1000), completed_at: new Date().toISOString() })
      .eq('id', runId)
    return res.status(200).json({ ok: true })
  }

  if (action === 'finish') {
    const r = body.result || {}
    const items: any[] = Array.isArray(r.items) ? r.items : []
    const jobs: any[] = Array.isArray(r.jobs) ? r.jobs : []
    const jobItems: any[] = Array.isArray(r.jobItems) ? r.jobItems : []

    if (items.length) {
      const { error } = await db.from('md_oncar_items').insert(items.map(i => ({
        run_id: runId,
        md_stock_id: num(i.md_stock_id),
        sku: i.sku ?? null,
        name: i.name ?? null,
        on_cars: num(i.on_cars) ?? 0,
        jobs_count: num(i.jobs_count) ?? 0,
        on_hand: num(i.on_hand),
        available: num(i.available),
        buy_price: num(i.buy_price),
        bin: i.bin ?? null,
        location: i.location ?? null,
      })))
      if (error) return res.status(500).json({ error: error.message })
    }

    if (jobs.length) {
      const { error } = await db.from('md_oncar_jobs').insert(jobs.map(j => ({
        run_id: runId,
        md_job_id: num(j.md_job_id),
        job_number: j.job_number ?? null,
        customer_name: j.customer_name ?? null,
        vehicle: j.vehicle ?? null,
        rego: j.rego ?? null,
        description: j.description ? String(j.description).slice(0, 2000) : null,
        diary_status: j.diary_status ?? null,
        invoice_number: j.invoice_number ?? null,
        scheduled_at: j.scheduled_at ?? null,
        days_open: num(j.days_open),
        parts_count: num(j.parts_count) ?? 0,
        parts_qty: num(j.parts_qty) ?? 0,
        parts_value: num(j.parts_value) ?? 0,
      })))
      if (error) return res.status(500).json({ error: error.message })
    }

    if (jobItems.length) {
      // Chunked: a busy year can push this well past a comfortable single insert.
      for (let i = 0; i < jobItems.length; i += 500) {
        const { error } = await db.from('md_oncar_job_items').insert(jobItems.slice(i, i + 500).map(x => ({
          run_id: runId,
          md_job_id: num(x.md_job_id),
          md_stock_id: num(x.md_stock_id),
          sku: x.sku ?? null,
          name: x.name ?? null,
          quantity: num(x.quantity) ?? 0,
        })))
        if (error) return res.status(500).json({ error: error.message })
      }
    }

    const { error: upErr } = await db.from('md_oncar_runs').update({
      status: 'done',
      from_date: r.fromYmd || null,
      to_date: r.toYmd || null,
      days_swept: num(r.daysSwept) ?? 0,
      days_failed: num(r.daysFailed) ?? 0,
      jobs_scanned: num(r.jobsScanned) ?? 0,
      jobs_count: jobs.length,
      items_count: items.length,
      units_total: num(r.unitsTotal) ?? 0,
      value_total: num(r.valueTotal) ?? 0,
      completed_at: new Date().toISOString(),
    }).eq('id', runId)
    if (upErr) return res.status(500).json({ error: upErr.message })

    // Keep the table from growing without bound — the screen only ever reads
    // the newest done run.
    const { data: old } = await db.from('md_oncar_runs')
      .select('id').order('created_at', { ascending: false }).range(20, 200)
    if (old?.length) await db.from('md_oncar_runs').delete().in('id', old.map(o => o.id))

    return res.status(200).json({ ok: true, items: items.length, jobs: jobs.length })
  }

  return res.status(400).json({ error: `Unknown action "${action}"` })
}

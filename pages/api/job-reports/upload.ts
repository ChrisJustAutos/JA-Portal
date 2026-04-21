// pages/api/job-reports/upload.ts
// Upload a job report CSV/XLSX. Parses, replaces the "current" job set.
// After upload, re-runs the PO→job matcher against all "parsed" invoices
// so new uploads don't miss previously-unmatched invoices.
//
// Request body (JSON):
//   {
//     filename: string,
//     file_base64: string,   // CSV or XLSX as base64
//     notes?: string
//   }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, getSessionUser } from '../../../lib/auth'
import { parseJobReport } from '../../../lib/job-report-parser'

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
}

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    try {
      const { filename, file_base64, notes } = req.body || {}
      if (!filename || !file_base64) { res.status(400).json({ error: 'filename and file_base64 required' }); return }

      const buf = Buffer.from(file_base64, 'base64')
      const parsed = parseJobReport(buf, filename)
      if (parsed.jobs.length === 0) {
        res.status(422).json({ error: 'No job rows parsed', warnings: parsed.warnings, headerMap: parsed.headerMap }); return
      }

      // Insert the new run (is_current=false for now; we flip it after jobs inserted OK)
      const { data: run, error: runErr } = await sb().from('job_report_runs').insert({
        uploaded_by: user?.id || null,
        source: 'manual',
        filename,
        row_count: parsed.jobs.length,
        notes: notes || null,
        is_current: false,
      }).select().single()
      if (runErr) throw new Error('Failed to create run: ' + runErr.message)

      // Insert jobs in chunks (Supabase has a default 1000-row limit per insert)
      const chunkSize = 500
      for (let i = 0; i < parsed.jobs.length; i += chunkSize) {
        const chunk = parsed.jobs.slice(i, i + chunkSize).map(j => ({
          run_id: run.id,
          job_number: j.job_number,
          customer_name: j.customer_name,
          vehicle: j.vehicle,
          status: j.status,
          opened_date: j.opened_date,
          closed_date: j.closed_date,
          job_type: j.job_type,
          estimated_total: j.estimated_total,
          raw: j.raw,
        }))
        const { error } = await sb().from('job_report_jobs').insert(chunk)
        if (error) throw new Error('Failed to insert jobs chunk: ' + error.message)
      }

      // Flip flags: this run is_current=true, everything else is_current=false
      await sb().from('job_report_runs').update({ is_current: false }).neq('id', run.id)
      await sb().from('job_report_runs').update({ is_current: true }).eq('id', run.id)

      // Re-match "parsed" status invoices against the new job set
      const { data: pendingInvoices } = await sb()
        .from('supplier_invoices')
        .select('id, po_number')
        .in('status', ['parsed'])
        .not('po_number', 'is', null)
      let rematched = 0
      if (pendingInvoices && pendingInvoices.length > 0) {
        for (const inv of pendingInvoices) {
          if (!inv.po_number) continue
          const { data: m } = await sb()
            .from('job_report_jobs')
            .select('id')
            .eq('run_id', run.id)
            .ilike('job_number', inv.po_number)
            .maybeSingle()
          if (m?.id) {
            await sb().from('supplier_invoices').update({
              po_matches_job: true,
              matched_job_id: m.id,
              matched_at: new Date().toISOString(),
            }).eq('id', inv.id)
            rematched++
          }
        }
      }

      res.status(200).json({
        ok: true,
        run_id: run.id,
        job_count: parsed.jobs.length,
        warnings: parsed.warnings,
        headerMap: parsed.headerMap,
        rematched_invoices: rematched,
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown error' })
    }
  })
}

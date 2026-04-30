// lib/job-report-upload.ts
// Core ingestion logic for Mechanics Desk Job exports.
//
// Two "lanes" via report_type:
//   • forecast      — rich manual export (Job Date, Job Types, Total, Quoted Total,
//                     Estimate Hours, Profit Margin, Source Of Business, ...).
//                     Drives the Forecasting page.
//                     Sources: manual upload, GitHub Actions auto-pull (Playwright).
//   • wip_snapshot  — limited daily WIP report from Pipeline C webhook.
//                     Reserved for a future Overview "Today's Workshop" widget;
//                     deliberately ignored by Forecasting because it lacks Job Date,
//                     real Job Types, and Total.
//
// Each lane has its own is_current pointer (DB-enforced via unique partial
// index on report_type WHERE is_current = true) so they never overwrite
// each other.

import { createClient } from '@supabase/supabase-js'
import { parseJobReport, ParsedJobReport } from './job-report-parser'

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export type JobReportType = 'forecast' | 'wip_snapshot'

export interface IngestJobReportInput {
  buffer: Buffer
  filename: string
  source: 'manual' | 'graph_mail' | 'cron' | 'api'
  reportType: JobReportType
  uploadedBy?: string | null
  notes?: string | null
}

export interface IngestJobReportResult {
  ok: true
  runId: string
  jobCount: number
  warnings: string[]
  headerMap: Record<string, string>
  rematchedInvoices: number
  durationMs: number
  reportType: JobReportType
}

export async function ingestJobReport(input: IngestJobReportInput): Promise<IngestJobReportResult> {
  const tStart = Date.now()

  const parsed: ParsedJobReport = parseJobReport(input.buffer, input.filename)
  if (parsed.jobs.length === 0) {
    throw new Error(
      `No job rows parsed from "${input.filename}". Warnings: ${parsed.warnings.join('; ') || 'none'}. Header map: ${JSON.stringify(parsed.headerMap)}`,
    )
  }

  const { data: run, error: runErr } = await sb().from('job_report_runs').insert({
    uploaded_by: input.uploadedBy || null,
    source: input.source,
    report_type: input.reportType,
    filename: input.filename,
    row_count: parsed.jobs.length,
    notes: input.notes || null,
    is_current: false,
  }).select().single()
  if (runErr || !run) throw new Error(`Failed to create run: ${runErr?.message || 'unknown'}`)

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
      vehicle_platform: j.vehicle_platform,
      raw: j.raw,
    }))
    const { error } = await sb().from('job_report_jobs').insert(chunk)
    if (error) throw new Error(`Failed to insert jobs chunk ${i}-${i + chunk.length}: ${error.message}`)
  }

  // Flip is_current — within this lane only. Cross-lane: forecast and
  // wip_snapshot each maintain their own current pointer, so a wip_snapshot
  // import never knocks the forecast pointer off the current manual upload.
  await sb().from('job_report_runs')
    .update({ is_current: false })
    .eq('report_type', input.reportType)
    .neq('id', run.id)
  await sb().from('job_report_runs')
    .update({ is_current: true })
    .eq('id', run.id)

  // Re-match pending supplier invoices — only relevant for the forecast lane
  // (the rich data has the proper job set). wip_snapshot is too thin.
  let rematched = 0
  if (input.reportType === 'forecast') {
    const { data: pendingInvoices } = await sb()
      .from('supplier_invoices')
      .select('id, po_number')
      .in('status', ['parsed'])
      .not('po_number', 'is', null)

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
  }

  return {
    ok: true,
    runId: run.id,
    jobCount: parsed.jobs.length,
    warnings: parsed.warnings,
    headerMap: parsed.headerMap,
    rematchedInvoices: rematched,
    durationMs: Date.now() - tStart,
    reportType: input.reportType,
  }
}

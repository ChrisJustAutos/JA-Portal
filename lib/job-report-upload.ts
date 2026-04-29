// lib/job-report-upload.ts
// Core ingestion logic for Mechanics Desk Job WIP reports. Used by:
//   • Manual upload  → /api/job-reports/upload
//   • Pipeline C webhook → /api/webhooks/graph-jobreport-mail (nightly auto-import)
//
// Responsibilities:
//   1. Parse the file (CSV or XLSX) via lib/job-report-parser
//   2. Insert a new job_report_runs row (with the given source label)
//   3. Insert all parsed jobs into job_report_jobs in chunks
//   4. Flip is_current so downstream queries point at the new run
//   5. Re-match any 'parsed' supplier invoices against the new job set

import { createClient } from '@supabase/supabase-js'
import { parseJobReport, ParsedJobReport } from './job-report-parser'

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export interface IngestJobReportInput {
  buffer: Buffer
  filename: string
  source: 'manual' | 'graph_mail' | 'cron' | 'api'
  uploadedBy?: string | null   // user ID for manual, null for system
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
}

/**
 * Ingest a Mechanics Desk job WIP report. Replaces the current run.
 *
 * Throws on failure (parse error, DB error, etc). Caller is responsible
 * for catching and translating to HTTP responses or webhook event logs.
 */
export async function ingestJobReport(input: IngestJobReportInput): Promise<IngestJobReportResult> {
  const tStart = Date.now()

  // 1. Parse
  const parsed: ParsedJobReport = parseJobReport(input.buffer, input.filename)
  if (parsed.jobs.length === 0) {
    throw new Error(
      `No job rows parsed from "${input.filename}". Warnings: ${parsed.warnings.join('; ') || 'none'}. Header map: ${JSON.stringify(parsed.headerMap)}`,
    )
  }

  // 2. Create run row (is_current=false until jobs are in)
  const { data: run, error: runErr } = await sb().from('job_report_runs').insert({
    uploaded_by: input.uploadedBy || null,
    source: input.source,
    filename: input.filename,
    row_count: parsed.jobs.length,
    notes: input.notes || null,
    is_current: false,
  }).select().single()
  if (runErr || !run) throw new Error(`Failed to create run: ${runErr?.message || 'unknown'}`)

  // 3. Insert jobs in chunks
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

  // 4. Flip is_current — only this run has it
  // Deliberate two-step: clear all others FIRST, then set new run, so we never
  // have a window with two current runs.
  await sb().from('job_report_runs').update({ is_current: false }).neq('id', run.id)
  await sb().from('job_report_runs').update({ is_current: true }).eq('id', run.id)

  // 5. Re-match 'parsed' supplier invoices against the new job set.
  // (Some invoices may have been waiting for a job number that's now in the report.)
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

  return {
    ok: true,
    runId: run.id,
    jobCount: parsed.jobs.length,
    warnings: parsed.warnings,
    headerMap: parsed.headerMap,
    rematchedInvoices: rematched,
    durationMs: Date.now() - tStart,
  }
}

// lib/ap-job-link.ts
// Link AP invoices to MD workshop jobs via the PO number on the invoice.
//
// Background: when a workshop person creates a Purchase Order in Mechanics
// Desk against a job, MD prints (or staff type) the MD job number into the
// supplier's "Customer P.O." field. So the AP-invoice-to-job link is just:
//
//   invoice.po_number  ←—match→  job_report_jobs.job_number
//
// The match is intentionally simple — exact (case-insensitive) after stripping
// common prefixes like "JOB ", "#". Anything fuzzier, the AP person can resolve
// manually via the picker UI.
//
// We use the public.job_report_jobs_latest view (DISTINCT ON job_number from
// the most recent run), so we ignore historical snapshots automatically.

import { createClient, SupabaseClient } from '@supabase/supabase-js'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export interface JobInfo {
  job_number: string
  customer_name: string | null
  vehicle: string | null
  status: string | null
  opened_date: string | null
  closed_date: string | null
  job_type: string | null
  vehicle_platform: string | null
  estimated_total: number | null
}

/**
 * Look up a single job by exact job_number (case-insensitive).
 * Returns null if no row in the latest snapshot matches.
 */
export async function getJobByNumber(jobNumber: string): Promise<JobInfo | null> {
  const c = sb()
  const target = jobNumber.trim()
  if (!target) return null
  const { data, error } = await c
    .from('job_report_jobs_latest')
    .select('*')
    .ilike('job_number', target)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('getJobByNumber error:', error.message)
    return null
  }
  return (data || null) as JobInfo | null
}

/**
 * Search jobs for the manual picker UI. Matches on job_number, customer_name,
 * or vehicle (case-insensitive ilike). Returns most recent first.
 */
export async function searchJobs(query: string, limit = 25): Promise<JobInfo[]> {
  const c = sb()
  const q = query.trim()
  if (!q) {
    // Empty query: return the most recent open jobs, useful as a starting list
    const { data } = await c
      .from('job_report_jobs_latest')
      .select('*')
      .order('snapshot_at', { ascending: false })
      .limit(limit)
    return (data || []) as JobInfo[]
  }
  const pat = `%${q}%`
  const { data, error } = await c
    .from('job_report_jobs_latest')
    .select('*')
    .or(`job_number.ilike.${pat},customer_name.ilike.${pat},vehicle.ilike.${pat}`)
    .order('snapshot_at', { ascending: false })
    .limit(limit)
  if (error) {
    console.error('searchJobs error:', error.message)
    return []
  }
  return (data || []) as JobInfo[]
}

/**
 * Normalise a PO field from a supplier invoice for matching against a job
 * number. Strips common prefixes the workshop guys put in front:
 *   "Job 12345"  → "12345"
 *   "JOB#12345"  → "12345"
 *   "#12345"     → "12345"
 *   "  20019-1 " → "20019-1"
 */
export function normalisePoCandidate(po: string): string {
  return po
    .toLowerCase()
    .trim()
    .replace(/^(job\s*#?|#)\s*/i, '')
    .trim()
}

/**
 * Attempt an automatic link of the invoice to a workshop job based on the
 * PO number. Returns the outcome WITHOUT writing to the DB — caller decides
 * whether to commit. This separation lets `applyTriageAndResolve` use it
 * inline and lets the manual link endpoint reuse the resolver if needed.
 *
 * Behaviour:
 *   - poNumber null/empty            → { status: 'no-po-on-invoice' }
 *   - poNumber, exact match found    → { status: 'matched', job }
 *   - poNumber, no match             → { status: 'unmatched' }
 */
export interface AutoLinkResult {
  status: 'matched' | 'unmatched' | 'no-po-on-invoice'
  job: JobInfo | null
}

export async function attemptAutoLink(poNumber: string | null | undefined): Promise<AutoLinkResult> {
  if (!poNumber || !poNumber.trim()) {
    return { status: 'no-po-on-invoice', job: null }
  }
  const candidate = normalisePoCandidate(poNumber)
  if (!candidate) return { status: 'no-po-on-invoice', job: null }

  const job = await getJobByNumber(candidate)
  if (job) return { status: 'matched', job }

  return { status: 'unmatched', job: null }
}

/**
 * Write the link to the invoice row. Used for both auto-linking (during
 * triage) and manual linking (from the UI).
 *
 * Pass jobNumber=null to clear an existing link.
 */
export async function writeJobLink(
  invoiceId: string,
  jobNumber: string | null,
  matchMethod: 'auto-po' | 'manual',
  poCheckStatus: 'matched' | 'unmatched' | 'no-po-on-invoice',
  linkedBy?: string,
): Promise<void> {
  const c = sb()
  const update: Record<string, any> = {
    linked_job_number:       jobNumber,
    linked_job_match_method: jobNumber ? matchMethod : null,
    linked_job_at:           jobNumber ? new Date().toISOString() : null,
    linked_job_by:           jobNumber ? (linkedBy || null) : null,
    po_check_status:         poCheckStatus,
  }
  const { error } = await c.from('ap_invoices').update(update).eq('id', invoiceId)
  if (error) throw new Error(`writeJobLink failed: ${error.message}`)
}

// lib/agent-framework/accounts.ts
// Accounts Agent — watches both MYOB files' payables: invoices awaiting review,
// invoices that failed to post, and supplier-statement reconciliation gaps.
//
// Phase 2 ships the read-only watchers (surface the review work in the inbox).
// The wholesale (JAWS) intake fix and the guarded auto-post of high-confidence
// invoices are the next increments.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { AgentContext, Finding } from './types'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

const cf = (s: string | null) => (s === 'JAWS' ? 'JAWS' : s === 'VPS' ? 'VPS' : '?')

// Invoices parsed but not yet posted/rejected that triage flagged for a human
// (red = blocking, yellow = needs a look). One rolled-up finding → /ap.
async function reviewQueue(): Promise<Finding[]> {
  const { data } = await sb().from('ap_invoices')
    .select('id, triage_status, myob_company_file')
    .neq('status', 'posted').neq('status', 'rejected')
    .in('triage_status', ['red', 'yellow'])
    .limit(500)
  const rows = (data || []) as any[]
  if (!rows.length) return []
  const red = rows.filter(r => r.triage_status === 'red').length
  const yellow = rows.length - red
  const byCf = rows.reduce((m: Record<string, number>, r) => { const k = cf(r.myob_company_file); m[k] = (m[k] || 0) + 1; return m }, {})
  const split = Object.entries(byCf).map(([k, n]) => `${n} ${k}`).join(', ')
  return [{
    kind: 'ap_review_queue',
    severity: red > 0 ? 'warn' : 'info',
    title: `${rows.length} supplier invoice${rows.length === 1 ? '' : 's'} awaiting review`,
    body: `${red} red (blocking), ${yellow} yellow${split ? ` · ${split}` : ''}. Review and post in AP Invoices.`,
    href: '/ap?triage=red',
    dedupeKey: 'accounts:review-queue',
    payload: { red, yellow, byCf },
  }]
}

// Invoices that errored on the way to MYOB and aren't posted — need a retry/fix.
async function postFailures(): Promise<Finding[]> {
  const { data } = await sb().from('ap_invoices')
    .select('id, vendor_name_parsed, invoice_number, myob_post_error, myob_company_file')
    .not('myob_post_error', 'is', null)
    .neq('status', 'posted')
    .limit(200)
  const rows = (data || []) as any[]
  if (!rows.length) return []
  const sample = rows.slice(0, 5).map(r => `· ${r.vendor_name_parsed || '?'} ${r.invoice_number || ''} (${cf(r.myob_company_file)}): ${String(r.myob_post_error).slice(0, 100)}`).join('\n')
  return [{
    kind: 'ap_post_failures',
    severity: 'warn',
    title: `${rows.length} invoice${rows.length === 1 ? '' : 's'} failed to post to MYOB`,
    body: `${sample}${rows.length > 5 ? `\n…and ${rows.length - 5} more` : ''}`,
    href: '/ap',
    dedupeKey: 'accounts:post-failures',
    payload: { count: rows.length },
  }]
}

// Supplier statements where invoices are missing from MYOB (or couldn't be
// matched to a supplier). Pulls from the statement watcher's results.
async function statementGaps(): Promise<Finding[]> {
  const since = new Date(Date.now() - 45 * 86400_000).toISOString()
  const { data } = await sb().from('ap_statement_scans')
    .select('supplier_name, company_file, match_status, missing_count, scanned_at')
    .in('match_status', ['has_missing', 'needs_review'])
    .gte('scanned_at', since)
    .order('scanned_at', { ascending: false })
    .limit(100)
  const rows = (data || []) as any[]
  if (!rows.length) return []
  const missing = rows.filter(r => r.match_status === 'has_missing')
  const review = rows.filter(r => r.match_status === 'needs_review')
  const lines = [
    ...missing.map(r => `· ${r.supplier_name || '?'} (${cf(r.company_file)}): ${r.missing_count || 0} missing in MYOB`),
    ...review.map(r => `· ${r.supplier_name || '?'} (${cf(r.company_file)}): needs manual reconcile`),
  ].slice(0, 8)
  return [{
    kind: 'ap_statement_gaps',
    severity: 'warn',
    title: `${rows.length} supplier statement${rows.length === 1 ? '' : 's'} with gaps`,
    body: `${lines.join('\n')}${rows.length > 8 ? `\n…and ${rows.length - 8} more` : ''}`,
    href: '/ap/statement',
    dedupeKey: 'accounts:statement-gaps',
    payload: { missing: missing.length, needs_review: review.length },
  }]
}

export async function runAccounts(_ctx: AgentContext): Promise<Finding[]> {
  const findings: Finding[] = []
  for (const watcher of [reviewQueue, postFailures, statementGaps]) {
    try { findings.push(...(await watcher())) }
    catch (e: any) { console.error(`[accounts] watcher ${watcher.name} failed:`, e?.message || e) }
  }
  return findings
}

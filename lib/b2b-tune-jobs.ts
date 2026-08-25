// lib/b2b-tune-jobs.ts
// SERVER-ONLY. Distributor tune jobs, end to end:
//
//   1. ingestTuneJobEmails() — scan the accounts inbox for Stripe receipts
//      ("a tune has been done"), LLM-extract company / VIN / tune details,
//      store the invoice PDF, match the company name to a b2b_distributor
//      (b2b_tune_company_aliases + display/trading-name match) and create a
//      b2b_tune_jobs row. Matched jobs bell+push the distributor.
//   2. The distributor fills in the customer details at /b2b/jobs
//      (submitTuneJobDetails), with weekly reminders until they do
//      (sendTuneJobReminders).
//   3. On submit: queue the MechanicDesk customer+vehicle for the GH-Actions
//      worker (status 'submitted' + md_synced_at null) and queue the customer
//      thank-you letter carrying the DISTRIBUTOR's details. (A Monday step
//      existed at launch; Chris scrapped it 2026-07-24 — MD is the sole
//      destination.)
//
// Config: TUNE_JOBS_MAILBOX overrides the scanned inbox (default
// accounts@justautoswholesale.com); TUNE_JOBS_FOLDER overrides the filed
// subfolder name (default "payment").

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  listMessagesWithAttachments, getMessageBody,
  listAttachmentMeta, getAttachmentBase64, sendMail,
} from './microsoft-graph'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const EXTRACT_MODEL = process.env.TUNE_JOBS_EXTRACTION_MODEL || 'claude-haiku-4-5-20251001'
const BUCKET = 'b2b-tune-invoices'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

// Stripe tune receipts land in the JAWS accounts inbox and staff manually
// file them into a "payment" subfolder — the scan covers Inbox + that folder.
const DEFAULT_MAILBOX = 'accounts@justautoswholesale.com'
const PAYMENT_FOLDER_NAME = process.env.TUNE_JOBS_FOLDER || 'payment'

function tuneJobsMailbox(): string {
  return (process.env.TUNE_JOBS_MAILBOX || '').trim() || DEFAULT_MAILBOX
}

// ── Distributor matching ────────────────────────────────────────────────

const normCompany = (s: any) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

export async function matchDistributorForCompany(companyRaw: string): Promise<string | null> {
  const c = sb()
  const norm = normCompany(companyRaw)
  if (!norm) return null
  const { data: alias } = await c.from('b2b_tune_company_aliases')
    .select('distributor_id').eq('company_raw', norm).maybeSingle()
  if (alias?.distributor_id) return alias.distributor_id
  const { data: dists } = await c.from('b2b_distributors')
    .select('id, display_name, trading_name').eq('is_active', true)
  for (const d of dists || []) {
    if (normCompany(d.display_name) === norm || normCompany((d as any).trading_name) === norm) return d.id
  }
  // Loose contains-match as a last resort (e.g. "Penrith 4x4 Pty Ltd").
  for (const d of dists || []) {
    const dn = normCompany(d.display_name)
    if (dn && (norm.includes(dn) || dn.includes(norm))) return d.id
  }
  return null
}

/**
 * Admin assigns an unmatched job's company to a distributor. The alias sticks
 * for future ingests AND every other unmatched job with the same payer name
 * is matched in the same click (Chris 2026-07-24: "if I match one job it
 * should match the rest"). Returns how many jobs were matched.
 */
export async function assignTuneJobDistributor(jobId: string, distributorId: string, saveAlias: boolean): Promise<{ matchedJobs: number }> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('company_raw, status').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  await c.from('b2b_tune_jobs').update({
    distributor_id: distributorId,
    status: job.status === 'unmatched' ? 'awaiting_details' : job.status,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
  let matchedJobs = 1
  if (saveAlias && job.company_raw) {
    await c.from('b2b_tune_company_aliases')
      .upsert({ company_raw: normCompany(job.company_raw), distributor_id: distributorId }, { onConflict: 'company_raw' })
  }
  // Sweep the SIBLINGS: every other unmatched job whose payer name normalises
  // to the same value gets the same distributor, in this same click.
  if (job.company_raw) {
    const want = normCompany(job.company_raw)
    const { data: siblings } = await c.from('b2b_tune_jobs')
      .select('id, company_raw').eq('status', 'unmatched').neq('id', jobId)
    const ids = (siblings || []).filter(s => normCompany(s.company_raw) === want).map(s => s.id)
    if (ids.length) {
      await c.from('b2b_tune_jobs').update({
        distributor_id: distributorId, status: 'awaiting_details', updated_at: new Date().toISOString(),
      }).in('id', ids)
      matchedJobs += ids.length
    }
  }
  try {
    const { notifyDistributor } = await import('./push')
    await notifyDistributor(distributorId, {
      title: matchedJobs === 1 ? 'New tune job — customer details needed' : `${matchedJobs} tune jobs — customer details needed`,
      body: matchedJobs === 1 ? 'A recent tune needs its customer details filled in.' : 'Recent tunes need their customer details filled in.',
      href: '/b2b/jobs',
      tag: `tune-job-${jobId}`,
    })
  } catch (e: any) { console.error('tune-job assign notify failed:', e?.message) }
  return { matchedJobs }
}

/**
 * Dismiss a job AND exclude its payer name: every other unmatched job with
 * the same normalised name is dismissed in the same click, and future
 * receipts from that payer are skipped at ingest (b2b_tune_company_exclusions).
 */
export async function dismissTuneJob(jobId: string): Promise<{ dismissedJobs: number; excludedName: string | null }> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('company_raw').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  await c.from('b2b_tune_jobs').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', jobId)
  let dismissedJobs = 1
  const norm = normCompany(job.company_raw)
  if (norm) {
    await c.from('b2b_tune_company_exclusions').upsert({ company_raw: norm }, { onConflict: 'company_raw' })
    const { data: siblings } = await c.from('b2b_tune_jobs')
      .select('id, company_raw').eq('status', 'unmatched').neq('id', jobId)
    const ids = (siblings || []).filter(x => normCompany(x.company_raw) === norm).map(x => x.id)
    if (ids.length) {
      await c.from('b2b_tune_jobs').update({ status: 'dismissed', updated_at: new Date().toISOString() }).in('id', ids)
      dismissedJobs += ids.length
    }
  }
  return { dismissedJobs, excludedName: norm || null }
}

// ── LLM extraction ──────────────────────────────────────────────────────

interface TuneExtraction {
  is_tune_receipt: boolean
  company: string | null
  vin: string | null
  tune_details: string | null
  invoice_number: string | null
  amount: number | null
}

const EXTRACT_PROMPT = `You are reading a Stripe receipt/invoice email (or its attached PDF) received by Just Autos, an Australian vehicle tuning company. When one of Just Autos' DISTRIBUTORS performs a tune in the field, a Stripe receipt like this arrives — it identifies the distributor's company, the vehicle VIN and what tune was done.

Output ONLY a JSON object:
{
  "is_tune_receipt": true/false — is this a receipt/invoice for a vehicle TUNE (calibration/remap/EasyLock etc.)? false for unrelated Stripe emails (subscriptions, SaaS receipts, payout notifications).
  "company": "the customer/company name on the receipt — the business that PAID (the distributor). null if absent.",
  "vin": "the vehicle VIN if present anywhere (17 chars typically, may be shorter chassis format). Uppercase, strip spaces. null if absent.",
  "tune_details": "short description of the tune/products purchased (e.g. 'VDJ79 tune + EasyLock'). Join multiple line items with ' + '. null if absent.",
  "invoice_number": "the receipt/invoice number. null if absent.",
  "amount": total amount paid as a number (no currency symbol), or null
}`

async function extractTuneDetails(content: any[]): Promise<TuneExtraction | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: EXTRACT_MODEL, max_tokens: 1024, system: EXTRACT_PROMPT, messages: [{ role: 'user', content }] }),
  })
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    return {
      is_tune_receipt: j.is_tune_receipt === true,
      company: j.company ? String(j.company).trim() : null,
      vin: j.vin ? String(j.vin).toUpperCase().replace(/\s/g, '') : null,
      tune_details: j.tune_details ? String(j.tune_details).trim().slice(0, 500) : null,
      invoice_number: j.invoice_number ? String(j.invoice_number).trim().slice(0, 60) : null,
      amount: Number.isFinite(Number(j.amount)) ? Number(j.amount) : null,
    }
  } catch { return null }
}

// ── Ingestion ───────────────────────────────────────────────────────────

export interface IngestResult {
  scanned: number; created: number; matched: number; skipped: number; errors: string[]
  // Receipts folded into an existing same-VIN job (remap + lockup = one car).
  merged?: number
  // What the mailbox actually returned — surfaced in the admin toast/logs so a
  // zero-result scan is diagnosable (wrong folder? no attachments? old mail?).
  debug?: { mailbox: string; since: string; inboxSeen: number; paymentFolderFound: boolean; paymentSeen: number; sample: Array<{ from: string | null; subject: string | null; received: string; hasAttachments: boolean }> }
}

export async function ingestTuneJobEmails(opts: { lookbackDays?: number; maxNew?: number; sinceIso?: string; untilIso?: string } = {}): Promise<IngestResult> {
  // Cap the LLM/PDF work per invocation so a big backlog can't time the
  // function out — repeated runs (hourly cron / scan-now) drain the rest.
  const maxNew = Math.max(1, opts.maxNew ?? 15)
  const c = sb()
  const mailbox = tuneJobsMailbox()
  const out: IngestResult = { scanned: 0, created: 0, matched: 0, skipped: 0, errors: [] }
  if (!mailbox) { out.errors.push('No mailbox configured (TUNE_JOBS_MAILBOX)'); return out }

  const sinceIso = opts.sinceIso || new Date(Date.now() - (opts.lookbackDays ?? 7) * 24 * 3600_000).toISOString()
  const untilIso = opts.untilIso || undefined
  // Stripe receipt emails frequently have NO attachment (link-only) — keep
  // anything whose subject smells like a receipt/invoice; sender is checked below.
  // Scan the Inbox AND the "payment" subfolder staff manually file these
  // into. internetMessageId dedup is stable across moves, so a receipt seen
  // in the Inbox and later moved never creates a second job.
  // alsoSubjects /./ = keep EVERYTHING in the window (Stripe receipts are
  // often link-only with no attachment and subjects vary) — the sender check
  // below is the real filter.
  const msgs = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, untilIsoDate: untilIso, top: 500, alsoSubjects: /./ })
  const inboxSeen = msgs.length
  let paymentFolderFound = false
  let paymentSeen = 0
  let matchedFolder: string | null = null
  let allFolders: string[] = []
  try {
    const { listMailFolders } = await import('./microsoft-graph')
    const folders = await listMailFolders(mailbox)
    allFolders = folders.map(f => f.displayName)
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, '')
    const want = norm(PAYMENT_FOLDER_NAME)
    // Exact (space/case-insensitive) first, then contains — "Payments",
    // "Stripe Payments" etc. all count.
    const folder = folders.find(f => norm(f.displayName) === want)
      || folders.find(f => norm(f.displayName).includes(want))
    if (folder) {
      paymentFolderFound = true
      matchedFolder = folder.displayName
      const filed = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, untilIsoDate: untilIso, top: 500, folderId: folder.id, alsoSubjects: /./ })
      paymentSeen = filed.length
      const have = new Set(msgs.map(m => m.id))
      for (const f of filed) if (!have.has(f.id)) msgs.push(f)
    } else {
      out.errors.push(`No folder containing "${PAYMENT_FOLDER_NAME}" in ${mailbox} — scanned Inbox only. Folders: ${allFolders.join(', ').slice(0, 300)}`)
    }
  } catch (e: any) { out.errors.push(`payment-folder scan: ${e?.message}`) }

  out.debug = {
    mailbox, since: sinceIso, inboxSeen, paymentFolderFound, paymentSeen,
    matchedFolder, folders: allFolders,
    sample: msgs.slice(0, 10).map(m => ({ from: m.from, subject: m.subject, received: m.receivedDateTime, hasAttachments: m.hasAttachments })),
  } as any
  console.log('[tune-jobs ingest]', JSON.stringify(out.debug))

  // Batch dedup up front: the list now carries internetMessageId, so already-
  // ingested messages cost nothing (no attachment/meta calls) on re-runs —
  // backfill clicks over the same window stay fast.
  const seenSet = new Set<string>()
  {
    const keys = msgs.map(m => m.internetMessageId || `graph:${m.id}`)
    for (let i = 0; i < keys.length; i += 200) {
      const { data: seenRows } = await c.from('b2b_tune_jobs')
        .select('internet_message_id').in('internet_message_id', keys.slice(i, i + 200))
      for (const r of seenRows || []) seenSet.add(r.internet_message_id)
    }
  }

  // The reliable invariant (Chris 2026-07-24): every tune email carries an
  // attachment named "Invoice-JAWS…". That's the PRIMARY filter; a stripe.com
  // sender is kept as a fallback for any format drift.
  const JAWS_ATTACHMENT = /invoice[-_ ]?jaws/i
  for (const m of msgs) {
    if (out.created >= maxNew) break
    try {
      const dedupKey = m.internetMessageId || `graph:${m.id}`
      if (seenSet.has(dedupKey)) { out.skipped++; continue }

      const from = String(m.from || '').toLowerCase()
      let atts: Awaited<ReturnType<typeof listAttachmentMeta>> = []
      let jawsPdf: (typeof atts)[number] | undefined
      if (m.hasAttachments) {
        atts = await listAttachmentMeta(mailbox, m.id)
        jawsPdf = atts.find(a => JAWS_ATTACHMENT.test(a.name || ''))
      }
      if (!jawsPdf && !from.includes('stripe.com')) continue
      out.scanned++

      // Prefer the Invoice-JAWS PDF (the invoice copy Chris wants stored);
      // then any PDF; fall back to the email body for extraction.
      let pdfBase64: string | null = null
      let pdfName = 'invoice.pdf'
      {
        const pdf = jawsPdf || atts.find(a => /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.name))
        if (pdf) {
          pdfBase64 = await getAttachmentBase64(mailbox, m.id, pdf.id)
          pdfName = pdf.name || pdfName
        }
      }

      let content: any[]
      if (pdfBase64) {
        content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
                   { type: 'text', text: `Email subject: ${m.subject || ''}\nExtract per the instructions.` }]
      } else {
        const body = await getMessageBody(mailbox, m.id)
        const text = body.content.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 30000)
        content = [{ type: 'text', text: `Email subject: ${m.subject || ''}\nEmail from: ${m.from}\nEmail body:\n${text}` }]
      }

      const x = await extractTuneDetails(content)
      if (!x || !x.is_tune_receipt) { out.skipped++; continue }

      // Excluded payer (dismissed once in admin) — never create jobs again.
      if (x.company) {
        const { data: excl } = await c.from('b2b_tune_company_exclusions')
          .select('company_raw').eq('company_raw', normCompany(x.company)).maybeSingle()
        if (excl) { out.skipped++; continue }
      }

      // Store the PDF copy (best-effort — the job row is still created without it).
      let pdfPath: string | null = null
      if (pdfBase64) {
        try {
          const path = `${new Date().toISOString().slice(0, 10)}/${dedupKey.replace(/[^\w.-]/g, '_').slice(0, 80)}-${pdfName.replace(/[^\w.-]/g, '_').slice(0, 60)}`
          const { error: upErr } = await c.storage.from(BUCKET).upload(path, Buffer.from(pdfBase64, 'base64'), { contentType: 'application/pdf', upsert: true })
          if (!upErr) pdfPath = path
          else out.errors.push(`pdf upload: ${upErr.message}`)
        } catch (e: any) { out.errors.push(`pdf upload: ${e?.message}`) }
      }

      const distributorId = x.company ? await matchDistributorForCompany(x.company) : null

      // ONE JOB PER VIN (Chris 2026-07-29): a remap and a lockup kit are two
      // Stripe receipts for the SAME car — merging means the distributor
      // fills the customer details once. A second receipt merges into an
      // existing job for the same VIN + same distributor when that job is
      // still open, or completed within the last 45 days (older = a genuine
      // re-tune → new job). The receipt keeps its own row (status 'merged',
      // merged_into_job_id set) so email dedup + the PDF copy survive.
      if (x.vin) {
        const { data: existing } = await c.from('b2b_tune_jobs')
          .select('id, status, distributor_id, company_raw, tune_details, amount, invoice_number, email_received_at, created_at')
          .ilike('vin', String(x.vin).trim())
          .in('status', ['unmatched', 'awaiting_details', 'submitted', 'synced'])
          .order('created_at', { ascending: false }).limit(1).maybeSingle()
        const sameOwner = existing && (
          (distributorId && existing.distributor_id === distributorId) ||
          (!distributorId && !existing.distributor_id && normCompany(existing.company_raw) === normCompany(x.company))
        )
        const ageDays = existing
          ? (Date.now() - Date.parse(existing.email_received_at || existing.created_at)) / 86400_000
          : Infinity
        const mergeable = sameOwner && (
          ['unmatched', 'awaiting_details'].includes(existing!.status) || ageDays <= 45
        )
        if (mergeable) {
          const detail = String(x.tune_details || '').trim()
          const mergedDetails = detail && !String(existing!.tune_details || '').includes(detail)
            ? [existing!.tune_details, detail].filter(Boolean).join(' + ')
            : existing!.tune_details
          await c.from('b2b_tune_jobs').update({
            tune_details: mergedDetails ? String(mergedDetails).slice(0, 1000) : existing!.tune_details,
            amount: (Number(existing!.amount) || 0) + (Number(x.amount) || 0),
            invoice_number: [existing!.invoice_number, x.invoice_number].filter(Boolean).join(' + ').slice(0, 200) || existing!.invoice_number,
            updated_at: new Date().toISOString(),
          }).eq('id', existing!.id)
          const { error: mergeInsErr } = await c.from('b2b_tune_jobs').insert({
            internet_message_id: dedupKey,
            email_subject: m.subject, email_from: m.from, email_received_at: m.receivedDateTime,
            invoice_pdf_path: pdfPath, invoice_number: x.invoice_number, amount: x.amount,
            company_raw: x.company, distributor_id: distributorId,
            vin: x.vin, tune_details: x.tune_details, extraction: x as any,
            status: 'merged', merged_into_job_id: existing!.id,
          })
          if (mergeInsErr) out.errors.push(`merge insert: ${mergeInsErr.message}`)
          out.merged = (out.merged || 0) + 1
          continue
        }
      }

      const { data: row, error: insErr } = await c.from('b2b_tune_jobs').insert({
        internet_message_id: dedupKey,
        email_subject: m.subject, email_from: m.from, email_received_at: m.receivedDateTime,
        invoice_pdf_path: pdfPath, invoice_number: x.invoice_number, amount: x.amount,
        company_raw: x.company, distributor_id: distributorId,
        vin: x.vin, tune_details: x.tune_details, extraction: x as any,
        status: distributorId ? 'awaiting_details' : 'unmatched',
      }).select('id').single()
      if (insErr) { out.errors.push(`insert: ${insErr.message}`); continue }
      out.created++
      if (out.created >= maxNew) {
        out.errors.push(`Stopped after ${maxNew} new jobs this run — scan again to pull in the rest.`)
      }

      if (distributorId) {
        out.matched++
        // Per-tune email/push moved to sendDelayedTuneJobNotices() — the
        // notice now fires when the job becomes VISIBLE on the portal
        // (3-day delay, Chris 2026-08-05), not the moment the receipt lands.
      } else {
        try {
          const { notify } = await import('./notifications')
          await notify({
            module: 'b2b',
            title: 'Tune job needs matching',
            body: `Stripe receipt from "${x.company || 'unknown company'}" couldn't be matched to a distributor.`,
            href: '/admin/b2b/tune-jobs',
            dedupeKey: `tune-unmatched-${row.id}`,
            roles: ['admin', 'manager'],
          })
        } catch { /* best-effort */ }
      }
    } catch (e: any) {
      out.errors.push(`${m.subject || m.id}: ${e?.message || e}`)
    }
  }
  return out
}

// ── Distributor submit + downstream sync ───────────────────────────────

export interface TuneJobDetails {
  customer_name: string
  // Legacy input — the forms now capture ONE "first & last" name field and
  // the first name is derived from it; still accepted if a caller sends it.
  customer_first_name?: string | null
  customer_phone?: string | null
  customer_email?: string | null
  customer_address_line1?: string | null
  customer_suburb?: string | null
  customer_state?: string | null
  customer_postcode?: string | null
  vehicle_rego?: string | null
  // MD-style vehicle fields (2026-07-28). vehicle_description still accepted
  // from old clients; when make/model/year arrive it's composed from them.
  vehicle_make?: string | null
  vehicle_model?: string | null
  vehicle_year?: string | null
  vehicle_description?: string | null
  job_notes?: string | null
}

// A dialable AU number: 10 digits starting with 0, or the +61 form
// (61 + 9 digits). Mirrored client-side on both fill forms.
export function isFullAuPhone(v: string | null | undefined): boolean {
  const digits = String(v || '').replace(/\D/g, '')
  return (digits.length === 10 && digits.startsWith('0')) ||
         (digits.length === 11 && digits.startsWith('61'))
}

export async function submitTuneJobDetails(jobId: string, distributorId: string, userId: string | null, d: TuneJobDetails): Promise<void> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, status').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  if (job.distributor_id !== distributorId) throw new Error('Job belongs to a different distributor')
  if (job.status !== 'awaiting_details') throw new Error(`Job is ${job.status}`)
  const name = String(d.customer_name || '').trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Customer name is required')
  // One name field carries first AND last (Penrith submitted bare surnames
  // 2026-07-28 — MD cards named just "Moore"). Business names pass naturally.
  if (name.split(' ').length < 2) throw new Error('Please enter the customer’s first and last name')
  // Full phone required — Penrith submitted a 9-digit number (048876088,
  // 2026-07-28) that can't be dialled. 10 digits starting 0, or +61 form.
  if (!isFullAuPhone(d.customer_phone)) {
    throw new Error('Please enter the customer’s full phone number (10 digits, e.g. 0400 123 456)')
  }

  const s = (v: any, n: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null }
  // MD-style vehicle fields; description composed for letters/back-compat.
  const vMake = s(d.vehicle_make, 40)
  const vModel = s(d.vehicle_model, 60)
  const vYear = s(d.vehicle_year, 10)
  const vDesc = s(d.vehicle_description, 120) ||
    ([vYear, vMake, vModel].filter(Boolean).join(' ') || null)
  await c.from('b2b_tune_jobs').update({
    customer_name: name.slice(0, 200),
    customer_first_name: s(d.customer_first_name, 80) || name.split(' ')[0].slice(0, 80),
    customer_phone: s(d.customer_phone, 40),
    customer_email: s(d.customer_email, 200),
    customer_address_line1: s(d.customer_address_line1, 200),
    customer_suburb: s(d.customer_suburb, 80),
    customer_state: s(d.customer_state, 10),
    customer_postcode: s(d.customer_postcode, 10),
    vehicle_rego: s(d.vehicle_rego, 20),
    vehicle_make: vMake, vehicle_model: vModel, vehicle_year: vYear,
    vehicle_description: vDesc,
    job_notes: s(d.job_notes, 1000),
    filled_by_user_id: userId, filled_at: new Date().toISOString(),
    status: 'submitted', updated_at: new Date().toISOString(),
  }).eq('id', jobId)

  // Queue the letter now (best-effort, logged into sync_error).
  // MechanicDesk customer+vehicle are created by the GH-Actions worker.
  try { await syncTuneJobDownstream(jobId) } catch (e: any) { console.error('tune-job sync failed:', e?.message) }
}

// Monday follow-up board: every submitted tune job becomes an item so staff
// ring the customer about their distributor experience (Chris 2026-07-28).
// Board "Distributor Tune Follow Ups" (workspace Just Autos), group "Tune
// Customers", items land as Call Status "To Call".
const TUNE_FOLLOWUP_BOARD = process.env.TUNE_FOLLOWUP_MONDAY_BOARD || '5030245210'
const TUNE_FOLLOWUP_GROUP = process.env.TUNE_FOLLOWUP_MONDAY_GROUP || 'group_mm5ppym0'
const TUNE_FOLLOWUP_COLS = {
  STATUS: 'color_mm5pxxq',      // 0 = To Call
  PHONE: 'text_mm5pwqtt',
  EMAIL: 'text_mm5p40tz',
  DISTRIBUTOR: 'text_mm5p6hs6',
  VEHICLE: 'text_mm5p20fj',
  REGO: 'text_mm5pvnz8',
  TUNE: 'text_mm5pnnpd',
  DATE: 'date_mm5pjrnt',
  PACKAGE: 'long_text_mm5pa57g',   // "Package Details" — the distributor's job_notes
  // Location column. Monday's API only accepts lat/lng(+address) writes for
  // location columns, so submitted addresses are geocoded via Nominatim
  // (best-effort) and written properly; a geocode miss falls back to the item
  // NOTE only ("CP Performance address isn't coming through to Monday",
  // Chris 2026-08-06). The advisor still fills it manually on address-less
  // submissions.
  ADDRESS: 'location_mm5pza6f',
}

// Free OSM geocoder — ~1 req/sec etiquette (callers pace themselves), AU-only
// bias. Null on any miss; never throws.
async function geocodeAuAddress(q: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'JA-Portal/1.0 (accounts@justautosmechanical.com.au)' },
    })
    if (!r.ok) return null
    const j: any[] = await r.json()
    const lat = Number(j?.[0]?.lat), lng = Number(j?.[0]?.lon)
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  } catch { return null }
}

export async function syncTuneJobDownstream(jobId: string): Promise<void> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('*').eq('id', jobId).maybeSingle()
  // 'synced' allowed so the admin retry button can backfill the Monday item /
  // letter on jobs the MD worker has already completed.
  if (!job || !['submitted', 'synced'].includes(job.status)) return
  const { data: dist } = await c.from('b2b_distributors')
    .select('display_name, trading_name, primary_contact_email, ship_line1, ship_suburb, ship_state, ship_postcode')
    .eq('id', job.distributor_id).maybeSingle()
  const errs: string[] = []

  // Monday follow-up item (idempotent via monday_item_id).
  if (!job.monday_item_id) {
    try {
      const { mondayQuery } = await import('./monday-followup')
      const vehicle = [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ')
        || job.vehicle_description || ''
      const columnValues: Record<string, any> = {
        [TUNE_FOLLOWUP_COLS.STATUS]: { index: 0 },
        [TUNE_FOLLOWUP_COLS.DATE]: { date: new Date(job.filled_at || Date.now()).toISOString().slice(0, 10) },
      }
      if (job.customer_phone) columnValues[TUNE_FOLLOWUP_COLS.PHONE] = job.customer_phone
      if (job.customer_email) columnValues[TUNE_FOLLOWUP_COLS.EMAIL] = job.customer_email
      if (dist?.display_name) columnValues[TUNE_FOLLOWUP_COLS.DISTRIBUTOR] = dist.display_name
      if (vehicle) columnValues[TUNE_FOLLOWUP_COLS.VEHICLE] = vehicle
      if (job.vehicle_rego) columnValues[TUNE_FOLLOWUP_COLS.REGO] = job.vehicle_rego
      if (job.tune_details) columnValues[TUNE_FOLLOWUP_COLS.TUNE] = String(job.tune_details).slice(0, 250)
      if (job.job_notes) columnValues[TUNE_FOLLOWUP_COLS.PACKAGE] = { text: String(job.job_notes).slice(0, 2000) }
      const submittedAddress = [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
      if (submittedAddress) {
        const geo = await geocodeAuAddress(submittedAddress)
        if (geo) columnValues[TUNE_FOLLOWUP_COLS.ADDRESS] = { lat: String(geo.lat), lng: String(geo.lng), address: submittedAddress }
      }
      const created = await mondayQuery<{ create_item: { id: string } }>(
        `mutation CreateTuneFollowUp($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
          create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues, create_labels_if_missing: false) { id }
        }`,
        {
          boardId: TUNE_FOLLOWUP_BOARD,
          groupId: TUNE_FOLLOWUP_GROUP,
          itemName: job.customer_name || 'Unknown customer',
          columnValues: JSON.stringify(columnValues),
        },
      )
      const itemId = created?.create_item?.id
      if (itemId) {
        await c.from('b2b_tune_jobs').update({ monday_item_id: String(itemId), updated_at: new Date().toISOString() }).eq('id', jobId)
        const note = [
          `Tuned by ${dist?.display_name || 'distributor'} — ring the customer about their experience.`,
          job.vin ? `VIN ${job.vin}` : '',
          job.invoice_number ? `Stripe invoice ${job.invoice_number}${job.amount ? ` · $${Number(job.amount).toFixed(2)}` : ''}` : '',
          job.job_notes ? `Distributor notes: ${job.job_notes}` : '',
          submittedAddress
            ? `Address on file: ${submittedAddress}`
            : '⚠ No address given — grab it on the call and put it in the Address column so the thank-you letter prints.',
        ].filter(Boolean).join('\n')
        await mondayQuery(
          `mutation Note($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
          { itemId, body: note },
        ).catch(() => { /* note is best-effort */ })
      } else {
        errs.push('Monday: create_item returned no id')
      }
    } catch (e: any) { errs.push(`Monday: ${String(e?.message || e).slice(0, 200)}`) }
  }

  // Customer letter with the DISTRIBUTOR's details (printed at JA on the
  // existing letter agent). Skipped when no address — the Monday follow-up
  // sweep queues it later once the sales advisor collects one on the call.
  if (!job.letter_queued_at && job.customer_address_line1) {
    const r = await queueTuneJobLetter(jobId, job, dist)
    if (r.error) errs.push(r.error)
  } else if (!job.letter_queued_at) {
    errs.push('Letter skipped: no customer address')
  }

  await c.from('b2b_tune_jobs').update({
    sync_error: errs.length ? errs.join(' | ').slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
}

// ---------------------------------------------------------------------------
// Admin corrections (Chris 2026-08-14: distributors made mistakes on
// submission). Staff edit the submitted details on /admin/b2b/tune-jobs; the
// corrections re-push to the Monday follow-up item immediately and queue an
// MD correction pass for the nightly worker when the job already has an MD
// customer (md_resync_pending → worker PUTs customer/vehicle + note).

export interface TuneJobAdminEdit extends TuneJobDetails {
  vin?: string | null            // receipt extraction can be wrong too
  tune_details?: string | null
}

const EDIT_FIELD_LABELS: Record<string, string> = {
  customer_name: 'name', customer_phone: 'phone', customer_email: 'email',
  customer_address_line1: 'address', customer_suburb: 'suburb',
  customer_state: 'state', customer_postcode: 'postcode',
  vehicle_rego: 'rego', vehicle_make: 'make', vehicle_model: 'model',
  vehicle_year: 'year', vin: 'VIN', tune_details: 'tune', job_notes: 'package details',
}

export interface TuneJobEditResult {
  changed: string[]; mondayUpdated: boolean; mdResyncQueued: boolean; letterNote: string | null
}

// Staff wrapper — edits any field including VIN/tune (receipt extraction can
// be wrong); the Monday correction update is attributed to Just Autos staff.
export function adminEditTuneJob(jobId: string, d: TuneJobAdminEdit): Promise<TuneJobEditResult> {
  return applyTuneJobEdit(jobId, d, { by: 'Just Autos staff' })
}

// Distributor self-service wrapper (Chris 2026-08-14: "need to be able to
// edit from Distributor side") — own jobs only, and only the fields their
// fill form owns: VIN + tune stay staff-only (they come from the receipt).
export async function distributorEditTuneJob(jobId: string, distributorId: string, d: TuneJobDetails): Promise<TuneJobEditResult> {
  const c = sb()
  const { data: dist } = await c.from('b2b_distributors').select('display_name').eq('id', distributorId).maybeSingle()
  const { vin: _v, tune_details: _t, ...fields } = d as TuneJobAdminEdit
  return applyTuneJobEdit(jobId, fields, { by: dist?.display_name || 'the distributor', distributorId })
}

async function applyTuneJobEdit(jobId: string, d: TuneJobAdminEdit, opts: { by: string; distributorId?: string }): Promise<TuneJobEditResult> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('*').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  if (opts.distributorId && job.distributor_id !== opts.distributorId) throw new Error('Job belongs to a different distributor')
  if (!['submitted', 'synced'].includes(job.status)) throw new Error(`Only submitted/synced jobs can be edited (this one is ${job.status})`)

  // Same rules the distributor forms enforce — corrections must not
  // reintroduce the mistakes the validation exists to stop.
  const name = String(d.customer_name || '').trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Customer name is required')
  if (name.split(' ').length < 2) throw new Error('Please enter the customer’s first and last name')
  if (!isFullAuPhone(d.customer_phone)) {
    throw new Error('Please enter the customer’s full phone number (10 digits, e.g. 0400 123 456)')
  }

  const s = (v: any, n: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null }
  // Only fields the caller actually sent are considered — a payload without
  // vin/tune (the distributor path) must never null them out.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(d, k)
  const eff = (k: keyof TuneJobAdminEdit, n: number) => has(k) ? s((d as any)[k], n) : (job[k] ?? null)
  const vMake = eff('vehicle_make', 40), vModel = eff('vehicle_model', 60), vYear = eff('vehicle_year', 10)
  const next: Record<string, any> = {
    customer_name: name.slice(0, 200),
    customer_first_name: name.split(' ')[0].slice(0, 80),
    customer_phone: s(d.customer_phone, 40),
    customer_email: eff('customer_email', 200),
    customer_address_line1: eff('customer_address_line1', 200),
    customer_suburb: eff('customer_suburb', 80),
    customer_state: eff('customer_state', 10),
    customer_postcode: eff('customer_postcode', 10),
    vehicle_rego: eff('vehicle_rego', 20),
    vehicle_make: vMake, vehicle_model: vModel, vehicle_year: vYear,
    vehicle_description: [vYear, vMake, vModel].filter(Boolean).join(' ')
      || (has('vehicle_description') ? s(d.vehicle_description, 120) : (job.vehicle_description ?? null)),
    vin: eff('vin', 40),
    tune_details: eff('tune_details', 500),
    job_notes: eff('job_notes', 1000),
  }
  const changed = Object.keys(EDIT_FIELD_LABELS).filter(k => (next[k] ?? null) !== (job[k] ?? null))
  if (!changed.length) return { changed: [], mondayUpdated: false, mdResyncQueued: false, letterNote: null }

  const mdResyncQueued = !!job.md_customer_md_id
  await c.from('b2b_tune_jobs').update({
    ...next,
    admin_edited_at: new Date().toISOString(),
    ...(mdResyncQueued ? { md_resync_pending: true } : {}),
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)

  const changedLabels = changed.map(k => EDIT_FIELD_LABELS[k])
  const monday = await updateTuneFollowupItem(jobId, changedLabels, opts.by)
  if (monday.error) {
    await c.from('b2b_tune_jobs').update({
      sync_error: `Monday correction failed: ${monday.error}`.slice(0, 1000),
      updated_at: new Date().toISOString(),
    }).eq('id', jobId)
  }

  // The thank-you letter prints from a queue — a correction after queueing
  // can't recall it, so surface that to the admin instead of pretending.
  const letterAffected = changed.some(k => k.startsWith('customer_') || k.startsWith('vehicle_') || k === 'tune_details')
  const letterNote = job.letter_queued_at && letterAffected
    ? 'The thank-you letter was already queued with the OLD details — reprint manually if it matters.'
    : null

  return { changed: changedLabels, mondayUpdated: monday.updated, mdResyncQueued, letterNote }
}

// Push the job's current details onto its Monday follow-up item: rename the
// item, rewrite the data columns (empty string clears), re-geocode the
// address, and post an update so the advisor sees what changed. Never throws.
async function updateTuneFollowupItem(jobId: string, changedLabels: string[], by: string): Promise<{ updated: boolean; error: string | null }> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('*').eq('id', jobId).maybeSingle()
  if (!job?.monday_item_id) return { updated: false, error: null }
  try {
    const { mondayQuery } = await import('./monday-followup')
    const vehicle = [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ')
      || job.vehicle_description || ''
    const columnValues: Record<string, any> = {
      name: job.customer_name || 'Unknown customer',
      [TUNE_FOLLOWUP_COLS.PHONE]: job.customer_phone || '',
      [TUNE_FOLLOWUP_COLS.EMAIL]: job.customer_email || '',
      [TUNE_FOLLOWUP_COLS.VEHICLE]: vehicle,
      [TUNE_FOLLOWUP_COLS.REGO]: job.vehicle_rego || '',
      [TUNE_FOLLOWUP_COLS.TUNE]: String(job.tune_details || '').slice(0, 250),
      [TUNE_FOLLOWUP_COLS.PACKAGE]: { text: String(job.job_notes || '').slice(0, 2000) },
    }
    const address = [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
    if (address) {
      const geo = await geocodeAuAddress(address)
      if (geo) columnValues[TUNE_FOLLOWUP_COLS.ADDRESS] = { lat: String(geo.lat), lng: String(geo.lng), address }
    }
    await mondayQuery(
      `mutation FixTuneFollowUp($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues, create_labels_if_missing: false) { id }
      }`,
      { boardId: TUNE_FOLLOWUP_BOARD, itemId: String(job.monday_item_id), columnValues: JSON.stringify(columnValues) },
    )
    const note = [
      `✏️ Details corrected by ${by} — ${changedLabels.join(', ')}.`,
      address ? `Address on file: ${address}` : '',
    ].filter(Boolean).join('\n')
    await mondayQuery(
      `mutation Note($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
      { itemId: String(job.monday_item_id), body: note },
    ).catch(() => { /* note is best-effort */ })
    return { updated: true, error: null }
  } catch (e: any) {
    return { updated: false, error: String(e?.message || e).slice(0, 200) }
  }
}

// Worker outcome for a correction pass: success clears the pending flag;
// a failure keeps it set so the next nightly run retries, with the error
// recorded where the admin page shows it.
export async function markTuneJobMdResynced(jobId: string, error?: string | null, note?: string | null): Promise<void> {
  const c = sb()
  await c.from('b2b_tune_jobs').update({
    ...(error ? {} : { md_resync_pending: false }),
    sync_error: error ? `MD correction failed: ${error}`.slice(0, 1000) : (note ? `MD correction: ${note}`.slice(0, 1000) : null),
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
}

// Queue the customer thank-you letter (default automation template with the
// distributor's sign-off block). addressOverride carries an advisor-entered
// address from the Monday board when the submission had none. Stamps
// letter_queued_at on success; returns an error string on failure.
async function queueTuneJobLetter(
  jobId: string,
  job: any,
  dist: { display_name?: string | null; ship_line1?: string | null; ship_suburb?: string | null; ship_state?: string | null; ship_postcode?: string | null; primary_contact_email?: string | null } | null,
  addressOverride?: string,
): Promise<{ queued: boolean; error?: string }> {
  const c = sb()
  try {
    const { getLetterAutomation, getTemplate, enqueueLetter } = await import('./workshop-letters')
    const auto = await getLetterAutomation()
    const template = auto.template_id ? await getTemplate(auto.template_id) : null
    if (!template) return { queued: false, error: 'Letter skipped: no default letter template configured' }
    // Distributor block = name + address ONLY — never emails (Chris 2026-08-19:
    // primary_contact_email can hold several ;-separated addresses and they all
    // printed on Harrop's customer letters). Rendered top-right on the letter,
    // opposite the customer name, not appended to the body.
    const distLines = [
      dist?.display_name || '',
      dist?.ship_line1 || '',
      [dist?.ship_suburb, dist?.ship_state, dist?.ship_postcode].filter(Boolean).join(' '),
    ].filter(Boolean)
    const vehicle = [job.vehicle_year, job.vehicle_make, job.vehicle_model].filter(Boolean).join(' ')
      || job.vehicle_description || job.tune_details || 'your vehicle'
    // Render with the FULL variable set the normal letter path uses — the
    // hand-rolled replace chain only knew first_name/vehicle/rego, so tokens
    // like {{business_name}} printed literally (Chris 2026-08-06).
    const { renderTemplate } = await import('./crm-automations')
    const body = renderTemplate(String(template.body || ''), {
      first_name: job.customer_first_name || (job.customer_name || '').split(' ')[0] || 'there',
      customer_name: job.customer_name || '',
      vehicle,
      rego: job.vehicle_rego ? String(job.vehicle_rego).toUpperCase() : '',
      date: new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' }),
      business_name: auto.letterhead_name || 'Just Autos',
      total: '',
    })
    const address = addressOverride?.trim()
      || [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')].filter(Boolean).join('\n')
    if (!address) return { queued: false, error: 'Letter skipped: no customer address' }
    const r = await enqueueLetter({
      trigger: 'auto',
      customer: { name: job.customer_name, first_name: job.customer_first_name, address },
      vehicle: job.vehicle_rego ? { rego: job.vehicle_rego, description: job.vehicle_description } : null,
      template,
      bodyOverride: body,
      recipientNameOverride: job.customer_name,
      recipientAddressOverride: address,
      asideTitle: 'Your local Just Autos distributor',
      asideLines: distLines,
    })
    if (r.status === 'queued') {
      await c.from('b2b_tune_jobs').update({ letter_job_id: r.jobId || null, letter_queued_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', jobId)
      return { queued: true }
    }
    return { queued: false, error: r.status === 'failed' ? `Letter: ${r.error || 'enqueue failed'}` : undefined }
  } catch (e: any) {
    return { queued: false, error: `Letter: ${e?.message}` }
  }
}

// Hourly (cron/tune-jobs): fill the Monday Address (location) column on items
// whose job HAS a submitted address but whose column is still empty — covers
// every item created before the geocoded write existed (CP Performance, Chris
// 2026-08-06) and any future geocode miss that later succeeds. Once the
// column has text it's never touched again (the advisor's manual entry wins).
export async function backfillTuneAddressColumns(): Promise<{ checked: number; filled: number; errors: string[] }> {
  const c = sb()
  const out = { checked: 0, filled: 0, errors: [] as string[] }
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, monday_item_id, customer_address_line1, customer_suburb, customer_state, customer_postcode')
    .not('monday_item_id', 'is', null)
    .not('customer_address_line1', 'is', null)
    .gte('created_at', new Date(Date.now() - 90 * 86400_000).toISOString())
    .limit(100)
  if (!jobs || jobs.length === 0) return out
  const { mondayQuery } = await import('./monday-followup')
  try {
    const data = await mondayQuery<{ items: Array<{ id: string; column_values: Array<{ id: string; text: string | null }> }> }>(
      `query Items($ids: [ID!]) { items (ids: $ids) { id column_values (ids: ["${TUNE_FOLLOWUP_COLS.ADDRESS}"]) { id text } } }`,
      { ids: jobs.map(j => String(j.monday_item_id)) },
    )
    const hasAddress = new Map<string, boolean>()
    for (const it of data?.items || []) {
      hasAddress.set(String(it.id), !!(it.column_values || []).some(cv => cv.id === TUNE_FOLLOWUP_COLS.ADDRESS && String(cv.text || '').trim()))
    }
    for (const job of jobs) {
      const itemId = String(job.monday_item_id)
      if (hasAddress.get(itemId) !== false) continue   // filled already, or item unreadable
      out.checked++
      const address = [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
      const geo = await geocodeAuAddress(address)
      // Nominatim etiquette: max ~1 req/sec.
      await new Promise(r => setTimeout(r, 1100))
      if (!geo) { out.errors.push(`${itemId}: geocode miss for "${address.slice(0, 80)}"`); continue }
      try {
        await mondayQuery(
          `mutation Set($boardId: ID!, $itemId: ID!, $value: JSON!) {
            change_column_value(board_id: $boardId, item_id: $itemId, column_id: "${TUNE_FOLLOWUP_COLS.ADDRESS}", value: $value) { id }
          }`,
          { boardId: TUNE_FOLLOWUP_BOARD, itemId, value: JSON.stringify({ lat: String(geo.lat), lng: String(geo.lng), address }) },
        )
        out.filled++
      } catch (e: any) {
        out.errors.push(`${itemId}: ${String(e?.message || e).slice(0, 150)}`)
      }
    }
  } catch (e: any) {
    out.errors.push(`Monday read: ${String(e?.message || e).slice(0, 200)}`)
  }
  return out
}

// ONE-SHOT repair (runs from the hourly cron, marker-guarded): letters queued
// 2026-08-05 → 2026-08-06 rendered {{business_name}} literally (the tune path
// hand-replaced only first_name/vehicle/rego — fixed above). Requeue them so
// they reprint with the full variable set; the bad prints get binned.
const LETTER_REQUEUE_MARKER = 'TUNE_LETTERS_REQUEUED_20260806'
export async function requeueBrokenTuneLetters(): Promise<{ requeued: number; skipped: boolean; errors: string[] }> {
  const c = sb()
  const { data: done } = await c.from('integration_settings').select('key').eq('key', LETTER_REQUEUE_MARKER).maybeSingle()
  if (done) return { requeued: 0, skipped: true, errors: [] }

  const out = { requeued: 0, skipped: false, errors: [] as string[] }
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, customer_name, customer_first_name, customer_address_line1, customer_suburb, customer_state, customer_postcode, tune_details, vehicle_rego, vehicle_make, vehicle_model, vehicle_year, vehicle_description, distributor_id, letter_queued_at')
    .gte('letter_queued_at', '2026-08-05T00:00:00Z')
    .lte('letter_queued_at', '2026-08-06T07:30:00Z')
  const distIds = Array.from(new Set((jobs || []).map((j: any) => j.distributor_id).filter(Boolean)))
  const distById = new Map<string, any>()
  if (distIds.length > 0) {
    const { data: dists } = await c.from('b2b_distributors')
      .select('id, display_name, ship_line1, ship_suburb, ship_state, ship_postcode, primary_contact_email')
      .in('id', distIds)
    for (const d of dists || []) distById.set(d.id, d)
  }
  for (const job of jobs || []) {
    // Clear the stamp so queueTuneJobLetter re-stamps; keep going on failure.
    const { error: clrErr } = await c.from('b2b_tune_jobs').update({ letter_queued_at: null, letter_job_id: null }).eq('id', job.id)
    if (clrErr) { out.errors.push(`${job.customer_name}: ${clrErr.message}`); continue }
    const r = await queueTuneJobLetter(job.id, job, distById.get(job.distributor_id) || null)
    if (r.queued) out.requeued++
    else out.errors.push(`${job.customer_name}: ${r.error || 'requeue failed'}`)
  }
  await c.from('integration_settings').upsert({ key: LETTER_REQUEUE_MARKER, value: new Date().toISOString() })
  return out
}

// Re-render + reprint the letters for specific tune jobs (e.g. after a layout
// fix — stored PDFs are pre-rendered at enqueue time, so a plain print-queue
// reprint would reuse the OLD artwork). Clears the letter stamp and runs the
// normal queueTuneJobLetter path so each job gets a fresh PDF + print jobs.
export async function requeueTuneJobLetters(jobIds: string[]): Promise<{ requeued: number; errors: string[] }> {
  const c = sb()
  const out = { requeued: 0, errors: [] as string[] }
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, customer_name, customer_first_name, customer_address_line1, customer_suburb, customer_state, customer_postcode, tune_details, vehicle_rego, vehicle_make, vehicle_model, vehicle_year, vehicle_description, distributor_id')
    .in('id', jobIds)
  const distIds = Array.from(new Set((jobs || []).map((j: any) => j.distributor_id).filter(Boolean)))
  const distById = new Map<string, any>()
  if (distIds.length > 0) {
    const { data: dists } = await c.from('b2b_distributors')
      .select('id, display_name, ship_line1, ship_suburb, ship_state, ship_postcode, primary_contact_email')
      .in('id', distIds)
    for (const d of dists || []) distById.set(d.id, d)
  }
  for (const job of jobs || []) {
    const { error: clrErr } = await c.from('b2b_tune_jobs').update({ letter_queued_at: null, letter_job_id: null }).eq('id', job.id)
    if (clrErr) { out.errors.push(`${job.customer_name}: ${clrErr.message}`); continue }
    const r = await queueTuneJobLetter(job.id, job, distById.get(job.distributor_id) || null)
    if (r.queued) out.requeued++
    else out.errors.push(`${job.customer_name}: ${r.error || 'requeue failed'}`)
  }
  return out
}

// Hourly sweep (cron/tune-jobs): jobs whose letter never went because the
// submission had no address. The sales advisor collects it on the follow-up
// call and types it into the Monday item's Address column — once it's there
// AND the call is done (Call Status "Called - …"), the letter/envelope
// automation fires with that address ("upon completion if not done prior",
// Chris 2026-07-28).
export async function sweepTuneFollowupLetters(): Promise<{ checked: number; lettersQueued: number; errors: string[] }> {
  const c = sb()
  const out = { checked: 0, lettersQueued: 0, errors: [] as string[] }
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, customer_name, customer_first_name, tune_details, vehicle_rego, vehicle_make, vehicle_model, vehicle_year, vehicle_description, monday_item_id, distributor_id')
    .in('status', ['submitted', 'synced'])
    .is('letter_queued_at', null)
    .not('monday_item_id', 'is', null)
    .limit(200)
  if (!jobs?.length) return out
  out.checked = jobs.length

  const { mondayQuery } = await import('./monday-followup')
  const itemInfo = new Map<string, { address: string; callStatus: string }>()
  const ids = jobs.map(j => String(j.monday_item_id))
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const data = await mondayQuery<{ items: Array<{ id: string; column_values: Array<{ id: string; text: string | null }> }> }>(
        `query TuneFollowups($ids: [ID!]) {
          items(ids: $ids) {
            id
            column_values(ids: ["${TUNE_FOLLOWUP_COLS.ADDRESS}", "${TUNE_FOLLOWUP_COLS.STATUS}"]) { id text }
          }
        }`,
        { ids: ids.slice(i, i + 50) },
      )
      for (const it of data.items || []) {
        const col = (id: string) => it.column_values?.find(cv => cv.id === id)?.text || ''
        itemInfo.set(String(it.id), { address: col(TUNE_FOLLOWUP_COLS.ADDRESS), callStatus: col(TUNE_FOLLOWUP_COLS.STATUS) })
      }
    } catch (e: any) {
      out.errors.push(`Monday read: ${String(e?.message || e).slice(0, 200)}`)
      return out   // can't see the board — try again next run
    }
  }

  // Distributor details for the letter sign-off block, one fetch per distinct id.
  const distIds = Array.from(new Set(jobs.map(j => j.distributor_id).filter(Boolean)))
  const distById = new Map<string, any>()
  if (distIds.length) {
    const { data: dists } = await c.from('b2b_distributors')
      .select('id, display_name, primary_contact_email, ship_line1, ship_suburb, ship_state, ship_postcode')
      .in('id', distIds)
    for (const d of dists || []) distById.set(d.id, d)
  }

  for (const job of jobs) {
    const info = itemInfo.get(String(job.monday_item_id))
    if (!info) continue
    const address = info.address.trim()
    // Fire only when the advisor has an address AND the call actually
    // happened — "Called - Happy" / "Called - Issue". "To Call" / "No
    // Answer" wait; "Skip" never triggers.
    if (!address || !/^called/i.test(info.callStatus.trim())) continue
    const r = await queueTuneJobLetter(job.id, job, distById.get(job.distributor_id) || null, address)
    if (r.queued) {
      out.lettersQueued++
      // Best-effort: note it on the Monday item so the advisor sees it went.
      await mondayQuery(
        `mutation Note($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }`,
        { itemId: String(job.monday_item_id), body: `📮 Thank-you letter queued to:\n${address}` },
      ).catch(() => {})
    } else if (r.error) {
      out.errors.push(`${job.customer_name || job.id}: ${r.error}`)
      await c.from('b2b_tune_jobs').update({ sync_error: r.error, updated_at: new Date().toISOString() }).eq('id', job.id)
    }
  }
  return out
}

/** Called by the MD worker when the MechanicDesk customer has been created. */
export async function markTuneJobMdSynced(jobId: string, mdCustomerId: string | null, error?: string | null, note?: string | null): Promise<void> {
  const c = sb()
  if (error) {
    await c.from('b2b_tune_jobs').update({ sync_error: `MD: ${error}`.slice(0, 1000), updated_at: new Date().toISOString() }).eq('id', jobId)
    return
  }
  await c.from('b2b_tune_jobs').update({
    md_customer_md_id: mdCustomerId, md_synced_at: new Date().toISOString(),
    status: 'synced', synced_at: new Date().toISOString(),
    // Non-fatal note (e.g. customer created but the vehicle attempt failed).
    sync_error: note ? String(note).slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
}

// ── Notification gate + recipients ──────────────────────────────────────
// Tune-job emails only START once the distributor actually uses the portal
// (Chris 2026-07-30): recipients = active portal users who have logged in at
// least once. Empty array = distributor hasn't adopted the portal yet — no
// emails (bell/push still fire; they're only visible in-portal anyway).
export async function distributorNotifiableEmails(distributorId: string): Promise<string[]> {
  const c = sb()
  const { data } = await c.from('b2b_distributor_users')
    .select('email')
    .eq('distributor_id', distributorId)
    .eq('is_active', true)
    .not('last_login_at', 'is', null)
    .not('email', 'like', 'preview+%@justautos.app')
  return Array.from(new Set((data || []).map(u => String(u.email || '').trim().toLowerCase()).filter(Boolean)))
}

// ── Weekly reminders ────────────────────────────────────────────────────

// ── Distributor-portal visibility delay (Chris 2026-08-05) ─────────────
// A completed tune appears on the distributor portal — and fires its "fill
// in the details" email/push — only N days (default 3) after the receipt
// arrived. Admin sees everything immediately. Anchor = email_received_at
// (the Stripe receipt ≈ tune-completed time), falling back to created_at.
export function tuneJobPortalDelayMs(): number {
  const days = Number(process.env.TUNE_JOBS_PORTAL_DELAY_DAYS ?? 3)
  return (Number.isFinite(days) ? Math.max(0, days) : 3) * 86400_000
}

export function tuneJobVisible(j: { email_received_at?: string | null; created_at?: string | null }): boolean {
  const anchor = j.email_received_at || j.created_at
  if (!anchor) return true
  return Date.now() - new Date(anchor).getTime() >= tuneJobPortalDelayMs()
}

// The per-tune "fill in the details" notice, moved OUT of ingest so it fires
// when the job becomes VISIBLE (post-delay), not the moment the receipt
// lands. Runs every cron tick; notified_at marks it sent. Distributors who
// have never logged in are skipped WITHOUT stamping (same gate as the Friday
// summary) so their notice fires on the first tick after their first login.
export async function sendDelayedTuneJobNotices(): Promise<{ notified: number }> {
  const c = sb()
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, vin, tune_details, invoice_number, email_received_at, created_at')
    .eq('status', 'awaiting_details')
    .is('notified_at', null)
    .not('distributor_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(200)
  const byDist = new Map<string, any[]>()
  for (const j of jobs || []) {
    if (!tuneJobVisible(j)) continue
    const g = byDist.get(j.distributor_id) || []
    g.push(j); byDist.set(j.distributor_id, g)
  }
  let notified = 0
  for (const [distId, djobs] of Array.from(byDist.entries())) {
    try {
      const emails = await distributorNotifiableEmails(distId)
      if (emails.length === 0) continue
      const { notifyDistributor } = await import('./push')
      const { getFromMailbox } = await import('./b2b-settings')
      for (const j of djobs) {
        try {
          await notifyDistributor(distId, {
            title: 'New tune job — customer details needed',
            body: `${j.tune_details || 'A recent tune'}${j.vin ? ` (VIN ${j.vin})` : ''} — tap to fill in the customer details.`,
            href: '/b2b/jobs',
            tag: `tune-job-${j.id}`,
          })
        } catch (e: any) { console.error('tune-job notify failed:', e?.message) }
        await sendMail(await getFromMailbox(), {
          to: emails,
          subject: `New tune job — customer details needed${j.vin ? ` (VIN ${j.vin})` : ''}`,
          html: `<p>Hi,</p>
<p>We've received the receipt for a tune you've completed:</p>
<ul><li><b>${j.tune_details || 'Tune'}</b>${j.vin ? `<br/>VIN ${j.vin}` : ''}${j.invoice_number ? `<br/>Invoice ${j.invoice_number}` : ''}</li></ul>
<p>Please fill in the customer and vehicle details so we can finish the paperwork — takes about a minute.</p>
<p style="margin:18px 0"><a href="https://justautos.app/b2b/jobs" style="background:#34c77b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Fill in the details</a></p>
<p>Thanks,<br/>Just Autos</p>`,
        })
        await c.from('b2b_tune_jobs').update({ notified_at: new Date().toISOString() }).eq('id', j.id)
        notified++
      }
    } catch (e: any) { console.error(`delayed tune-job notice failed for ${distId}:`, e?.message) }
  }
  return { notified }
}

export async function sendTuneJobReminders(): Promise<{ distributors: number; jobs: number }> {
  const c = sb()
  const weekAgo = new Date(Date.now() - 6.5 * 24 * 3600_000).toISOString()
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, vin, tune_details, last_reminder_at, first_reminded_at, created_at, email_received_at')
    .eq('status', 'awaiting_details')
    .not('distributor_id', 'is', null)
  // Jobs still inside the portal-visibility delay don't count — the summary
  // must never reference a job the distributor can't see yet.
  const due = (jobs || []).filter(j => tuneJobVisible(j) && (!j.last_reminder_at || j.last_reminder_at < weekAgo))
  const byDist = new Map<string, any[]>()
  for (const j of due) {
    const g = byDist.get(j.distributor_id) || []
    g.push(j); byDist.set(j.distributor_id, g)
  }
  let notified = 0
  for (const [distId, djobs] of Array.from(byDist.entries())) {
    try {
      // Gate (Chris 2026-07-30): no summary until the distributor has logged
      // in at least once. Deliberately skips the reminder stamps too, so the
      // first Friday AFTER their first login carries the full backlog.
      const emails = await distributorNotifiableEmails(distId)
      if (emails.length === 0) continue

      const { data: dist } = await c.from('b2b_distributors')
        .select('display_name').eq('id', distId).maybeSingle()
      const { notifyDistributor } = await import('./push')
      await notifyDistributor(distId, {
        title: `${djobs.length} tune job${djobs.length === 1 ? '' : 's'} waiting on customer details`,
        body: 'Please fill in the customer details so we can finish the paperwork.',
        href: '/b2b/jobs',
        tag: `tune-job-reminder-${distId}`,
      })
      const { getFromMailbox } = await import('./b2b-settings')
      const rows = djobs.map(j => `<li>${j.tune_details || 'Tune'}${j.vin ? ` — VIN ${j.vin}` : ''} (received ${String(j.created_at).slice(0, 10)})</li>`).join('')
      await sendMail(await getFromMailbox(), {
        to: emails,
        subject: `Weekly summary: ${djobs.length} tune job${djobs.length === 1 ? '' : 's'} still waiting on customer details`,
        html: `<p>Hi ${dist?.display_name || ''},</p><p>End-of-week wrap-up — the following tune job${djobs.length === 1 ? ' is' : 's are'} still waiting on customer details:</p><ul>${rows}</ul><p style="margin:18px 0"><a href="https://justautos.app/b2b/jobs" style="background:#34c77b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Fill in the details</a></p><p style="font-size:12px;color:#888">Sign in to the portal and open the Jobs tab — each one takes about a minute.</p><p>Thanks,<br/>Just Autos</p>`,
      })
      await c.from('b2b_tune_jobs').update({ last_reminder_at: new Date().toISOString() })
        .in('id', djobs.map(j => j.id))
      // Stage 1 of the escalation ladder: stamp the FIRST email per job.
      const firstIds = djobs.filter(j => !(j as any).first_reminded_at).map(j => j.id)
      if (firstIds.length) {
        await c.from('b2b_tune_jobs').update({ first_reminded_at: new Date().toISOString() }).in('id', firstIds)
      }
      notified++
    } catch (e: any) { console.error(`tune-job reminder failed for ${distId}:`, e?.message) }
  }
  return { distributors: notified, jobs: due.length }
}

// ── Internal recap after the reminders go out (Chris 2026-08-26) ────────
//
// The distributor reminders tell each distributor about their own jobs.
// Nobody here saw the whole picture, so there was no way to know whether the
// backlog was clearing week to week or just sitting there. This sends ONE
// email to Matt after the Friday run with every distributor's outstanding
// count, oldest job and dollar value.
//
// Sent whenever the reminder pass runs, including a manual ?remind=1 or the
// admin "Send reminders now" button - if you trigger a chase, you get the
// resulting picture. Reports EVERY distributor with jobs outstanding, not just
// the ones that were emailed, because a distributor who receives nothing
// (nobody has logged in) is the one most worth knowing about.

const TUNE_RECAP_EMAIL = process.env.TUNE_JOBS_RECAP_EMAIL || 'matt.h@justautosmechanical.com.au'

export interface TuneRecapRow {
  distributor: string
  jobs: number
  oldestDays: number
  value: number
  reminded: boolean
}

/** The per-distributor outstanding picture. Exported so it can be checked without sending. */
export async function tuneJobRecapRows(): Promise<TuneRecapRow[]> {
  const c = sb()
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, amount, created_at, email_received_at, last_reminder_at')
    .eq('status', 'awaiting_details')
    .not('distributor_id', 'is', null)

  // Same visibility rule the reminders use, so the recap can't report a job
  // the distributor has not been shown yet.
  const live = (jobs || []).filter(j => tuneJobVisible(j))
  const byDist = new Map<string, any[]>()
  for (const j of live) {
    const g = byDist.get(j.distributor_id) || []
    g.push(j); byDist.set(j.distributor_id, g)
  }
  if (byDist.size === 0) return []

  const { data: dists } = await c.from('b2b_distributors').select('id, display_name')
  const nameOf = new Map((dists || []).map(d => [d.id, d.display_name as string]))

  const rows: TuneRecapRow[] = []
  for (const [distId, djobs] of Array.from(byDist.entries())) {
    const emails = await distributorNotifiableEmails(distId)
    const oldest = djobs.reduce((min, j) => {
      const t = new Date(j.email_received_at || j.created_at).getTime()
      return Number.isFinite(t) && t < min ? t : min
    }, Date.now())
    rows.push({
      distributor: nameOf.get(distId) || '(unknown distributor)',
      jobs: djobs.length,
      oldestDays: Math.max(0, Math.floor((Date.now() - oldest) / 86400_000)),
      value: Math.round(djobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0)),
      reminded: emails.length > 0,
    })
  }
  // Worst first: most jobs, then oldest.
  rows.sort((a, b) => b.jobs - a.jobs || b.oldestDays - a.oldestDays)
  return rows
}

export async function sendTuneJobRecap(sent: { distributors: number; jobs: number }): Promise<{ sent: boolean; rows: number }> {
  const rows = await tuneJobRecapRows()
  const { getFromMailbox } = await import('./b2b-settings')

  const money = (n: number) => '$' + n.toLocaleString('en-AU')
  const totalJobs = rows.reduce((s, r) => s + r.jobs, 0)
  const totalValue = rows.reduce((s, r) => s + r.value, 0)
  const silent = rows.filter(r => !r.reminded)

  const body = rows.length === 0
    ? '<p><b>Nothing outstanding</b> — every tune job has its customer details in. Good week.</p>'
    : `<table cellpadding="7" cellspacing="0" style="border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f3f4f6;text-align:left">
          <th>Distributor</th><th style="text-align:right">Jobs</th>
          <th style="text-align:right">Oldest</th><th style="text-align:right">Value</th><th>Chased?</th>
        </tr></thead>
        <tbody>${rows.map(r => `<tr style="border-bottom:1px solid #e5e7eb">
          <td>${r.distributor}</td>
          <td style="text-align:right">${r.jobs}</td>
          <td style="text-align:right">${r.oldestDays}d</td>
          <td style="text-align:right">${money(r.value)}</td>
          <td>${r.reminded ? 'yes' : '<b style="color:#b45309">no — nobody has logged in</b>'}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr style="border-top:2px solid #111;font-weight:700">
          <td>Total</td><td style="text-align:right">${totalJobs}</td>
          <td></td><td style="text-align:right">${money(totalValue)}</td><td></td>
        </tr></tfoot>
      </table>`

  const note = silent.length > 0
    ? `<p style="color:#b45309"><b>${silent.length} distributor${silent.length === 1 ? '' : 's'} received no reminder</b> — ${silent.map(r => r.distributor).join(', ')}. Reminders only go to distributors with at least one portal login, so these will not chase themselves.</p>`
    : ''

  await sendMail(await getFromMailbox(), {
    to: [TUNE_RECAP_EMAIL],
    subject: `Tune jobs still to reconcile — ${totalJobs} across ${rows.length} distributor${rows.length === 1 ? '' : 's'}`,
    html: `<p>Reminders have just gone out: <b>${sent.jobs}</b> job${sent.jobs === 1 ? '' : 's'} chased across <b>${sent.distributors}</b> distributor${sent.distributors === 1 ? '' : 's'}.</p>
           <p>Still waiting on customer details:</p>
           ${body}
           ${note}
           <p style="margin:18px 0"><a href="https://justautos.app/admin/b2b/tune-jobs" style="background:#4f8ef7;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open Tune Jobs</a></p>
           <p style="font-size:12px;color:#888">Sent automatically after the weekly tune-job reminder run. "Oldest" is days since the Stripe receipt arrived.</p>`,
  })
  return { sent: true, rows: rows.length }
}

// ── Escalation ladder (Chris 2026-07-24) ────────────────────────────────
// Email first (weekly reminder stamps first_reminded_at) →
//   7 days unfilled → ONE SMS per distributor (business hours, Brisbane) →
//   10 more days → ONE summary email to Ryan.
// Runs every cron tick; stage stamps make each rung fire once per job.

const ESCALATION_EMAIL = process.env.TUNE_JOBS_ESCALATION_EMAIL || 'ryan@justautosmechanical.com.au'

export async function escalateTuneJobs(): Promise<{ smsDistributors: number; escalatedJobs: number }> {
  const c = sb()
  const now = Date.now()
  const out = { smsDistributors: 0, escalatedJobs: 0 }

  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, vin, tune_details, created_at, first_reminded_at, sms_reminded_at, escalated_at')
    .eq('status', 'awaiting_details')
    .not('distributor_id', 'is', null)
  const open = jobs || []

  // ── Stage 2: SMS at 7 days after the first email ──
  // Only during Brisbane business hours (Mon–Fri 9am–5pm) so nobody's phone
  // buzzes at 2am; due jobs simply wait for the next in-hours cron tick.
  const bris = new Date(now + 10 * 3600_000)
  const inHours = bris.getUTCDay() >= 1 && bris.getUTCDay() <= 5 && bris.getUTCHours() >= 9 && bris.getUTCHours() < 17
  if (inHours) {
    const smsDue = open.filter(j =>
      !j.sms_reminded_at && j.first_reminded_at && now - Date.parse(j.first_reminded_at) >= 7 * 86400_000)
    const byDist = new Map<string, any[]>()
    for (const j of smsDue) { const g = byDist.get(j.distributor_id) || []; g.push(j); byDist.set(j.distributor_id, g) }
    for (const [distId, djobs] of Array.from(byDist.entries())) {
      try {
        const { data: dist } = await c.from('b2b_distributors')
          .select('display_name, primary_contact_phone').eq('id', distId).maybeSingle()
        if (!dist?.primary_contact_phone) {
          // No mobile on file — skip the SMS rung, the Ryan rung still fires.
          await c.from('b2b_tune_jobs').update({ sms_reminded_at: new Date().toISOString(), sync_error: null }).in('id', djobs.map(j => j.id))
          continue
        }
        const { sendSms } = await import('./clicksend')
        const { signOrderAction } = await import('./order-action-token')
        const token = signOrderAction({ orderId: distId, scope: 'tune_jobs', ttlDays: 14 })
        const link = `https://justautos.app/tune-jobs?token=${encodeURIComponent(token)}`
        const r = await sendSms(dist.primary_contact_phone,
          `Just Autos: ${djobs.length === 1 ? 'a tune job is' : `${djobs.length} tune jobs are`} still waiting on customer details. Fill them in here (no login needed): ${link}`)
        if (r.ok) {
          await c.from('b2b_tune_jobs').update({ sms_reminded_at: new Date().toISOString() }).in('id', djobs.map(j => j.id))
          out.smsDistributors++
        } else {
          console.error(`tune-job SMS failed for ${dist.display_name}: ${r.error}`)
          if (r.error === 'clicksend_not_configured' || r.error === 'invalid_number') {
            // Permanent — don't retry every tick; move to the next rung.
            await c.from('b2b_tune_jobs').update({ sms_reminded_at: new Date().toISOString() }).in('id', djobs.map(j => j.id))
          }
        }
      } catch (e: any) { console.error(`tune-job SMS stage failed for ${distId}:`, e?.message) }
    }
  }

  // ── Stage 3: email Ryan at 10 days after the SMS ──
  const escDue = open.filter(j =>
    !j.escalated_at && j.sms_reminded_at && now - Date.parse(j.sms_reminded_at) >= 10 * 86400_000)
  if (escDue.length) {
    try {
      const distIds = Array.from(new Set(escDue.map(j => j.distributor_id)))
      const { data: dists } = await c.from('b2b_distributors').select('id, display_name').in('id', distIds)
      const nameOf = new Map((dists || []).map(d => [d.id, d.display_name]))
      const rows = escDue.map(j => {
        const age = Math.floor((now - Date.parse(j.created_at)) / 86400_000)
        return `<tr><td style="padding:4px 10px">${nameOf.get(j.distributor_id) || '?'}</td><td style="padding:4px 10px">${j.tune_details || 'Tune'}</td><td style="padding:4px 10px;font-family:monospace">${j.vin || '—'}</td><td style="padding:4px 10px">${age} days</td></tr>`
      }).join('')
      const { getFromMailbox } = await import('./b2b-settings')
      await sendMail(await getFromMailbox(), {
        to: [ESCALATION_EMAIL],
        subject: `Escalation: ${escDue.length} tune job${escDue.length === 1 ? '' : 's'} still missing customer details after email + SMS`,
        html: `<p>These tune jobs have been chased by email and SMS and are still missing customer details — a phone call is probably next:</p><table style="border-collapse:collapse;font-size:13px"><tr><th style="text-align:left;padding:4px 10px">Distributor</th><th style="text-align:left;padding:4px 10px">Tune</th><th style="text-align:left;padding:4px 10px">VIN</th><th style="text-align:left;padding:4px 10px">Age</th></tr>${rows}</table><p><a href="https://justautos.app/admin/b2b/tune-jobs">Open Tune Jobs in the portal →</a></p>`,
      })
      await c.from('b2b_tune_jobs').update({ escalated_at: new Date().toISOString() }).in('id', escDue.map(j => j.id))
      out.escalatedJobs = escDue.length
    } catch (e: any) { console.error('tune-job escalation email failed:', e?.message) }
  }

  return out
}

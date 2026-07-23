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
  listMessagesWithAttachments, getMessageMeta, getMessageBody,
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

/** Admin assigns an unmatched job's company to a distributor; the alias sticks. */
export async function assignTuneJobDistributor(jobId: string, distributorId: string, saveAlias: boolean): Promise<void> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('company_raw, status').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  await c.from('b2b_tune_jobs').update({
    distributor_id: distributorId,
    status: job.status === 'unmatched' ? 'awaiting_details' : job.status,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
  if (saveAlias && job.company_raw) {
    await c.from('b2b_tune_company_aliases')
      .upsert({ company_raw: normCompany(job.company_raw), distributor_id: distributorId }, { onConflict: 'company_raw' })
  }
  try {
    const { notifyDistributor } = await import('./push')
    await notifyDistributor(distributorId, {
      title: 'New tune job — customer details needed',
      body: 'A recent tune needs its customer details filled in.',
      href: '/b2b/jobs',
      tag: `tune-job-${jobId}`,
    })
  } catch (e: any) { console.error('tune-job assign notify failed:', e?.message) }
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
  // What the mailbox actually returned — surfaced in the admin toast/logs so a
  // zero-result scan is diagnosable (wrong folder? no attachments? old mail?).
  debug?: { mailbox: string; since: string; inboxSeen: number; paymentFolderFound: boolean; paymentSeen: number; sample: Array<{ from: string | null; subject: string | null; received: string; hasAttachments: boolean }> }
}

export async function ingestTuneJobEmails(opts: { lookbackDays?: number } = {}): Promise<IngestResult> {
  const c = sb()
  const mailbox = tuneJobsMailbox()
  const out: IngestResult = { scanned: 0, created: 0, matched: 0, skipped: 0, errors: [] }
  if (!mailbox) { out.errors.push('No mailbox configured (TUNE_JOBS_MAILBOX)'); return out }

  const sinceIso = new Date(Date.now() - (opts.lookbackDays ?? 7) * 24 * 3600_000).toISOString()
  // Stripe receipt emails frequently have NO attachment (link-only) — keep
  // anything whose subject smells like a receipt/invoice; sender is checked below.
  // Scan the Inbox AND the "payment" subfolder staff manually file these
  // into. internetMessageId dedup is stable across moves, so a receipt seen
  // in the Inbox and later moved never creates a second job.
  // alsoSubjects /./ = keep EVERYTHING in the window (Stripe receipts are
  // often link-only with no attachment and subjects vary) — the sender check
  // below is the real filter.
  const msgs = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, top: 100, alsoSubjects: /./ })
  const inboxSeen = msgs.length
  let paymentFolderFound = false
  let paymentSeen = 0
  try {
    const { findFolderByDisplayNameLoose } = await import('./microsoft-graph')
    const folderId = await findFolderByDisplayNameLoose(mailbox, PAYMENT_FOLDER_NAME)
    if (folderId) {
      paymentFolderFound = true
      const filed = await listMessagesWithAttachments(mailbox, { sinceIsoDate: sinceIso, top: 100, folderId, alsoSubjects: /./ })
      paymentSeen = filed.length
      const have = new Set(msgs.map(m => m.id))
      for (const f of filed) if (!have.has(f.id)) msgs.push(f)
    } else {
      out.errors.push(`"${PAYMENT_FOLDER_NAME}" folder not found in ${mailbox} — scanned Inbox only`)
    }
  } catch (e: any) { out.errors.push(`payment-folder scan: ${e?.message}`) }

  out.debug = {
    mailbox, since: sinceIso, inboxSeen, paymentFolderFound, paymentSeen,
    sample: msgs.slice(0, 10).map(m => ({ from: m.from, subject: m.subject, received: m.receivedDateTime, hasAttachments: m.hasAttachments })),
  }
  console.log('[tune-jobs ingest]', JSON.stringify(out.debug))

  // The reliable invariant (Chris 2026-07-24): every tune email carries an
  // attachment named "Invoice-JAWS…". That's the PRIMARY filter; a stripe.com
  // sender is kept as a fallback for any format drift.
  const JAWS_ATTACHMENT = /invoice[-_ ]?jaws/i
  for (const m of msgs) {
    try {
      const from = String(m.from || '').toLowerCase()
      let atts: Awaited<ReturnType<typeof listAttachmentMeta>> = []
      let jawsPdf: (typeof atts)[number] | undefined
      if (m.hasAttachments) {
        atts = await listAttachmentMeta(mailbox, m.id)
        jawsPdf = atts.find(a => JAWS_ATTACHMENT.test(a.name || ''))
      }
      if (!jawsPdf && !from.includes('stripe.com')) continue
      out.scanned++

      const meta = await getMessageMeta(mailbox, m.id)
      const dedupKey = meta.internetMessageId || `graph:${m.id}`
      const { data: seen } = await c.from('b2b_tune_jobs').select('id').eq('internet_message_id', dedupKey).maybeSingle()
      if (seen) { out.skipped++; continue }

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

      if (distributorId) {
        out.matched++
        try {
          const { notifyDistributor } = await import('./push')
          await notifyDistributor(distributorId, {
            title: 'New tune job — customer details needed',
            body: `${x.tune_details || 'A recent tune'}${x.vin ? ` (VIN ${x.vin})` : ''} — tap to fill in the customer details.`,
            href: '/b2b/jobs',
            tag: `tune-job-${row.id}`,
          })
        } catch (e: any) { console.error('tune-job notify failed:', e?.message) }
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
  customer_first_name?: string | null
  customer_phone?: string | null
  customer_email?: string | null
  customer_address_line1?: string | null
  customer_suburb?: string | null
  customer_state?: string | null
  customer_postcode?: string | null
  vehicle_rego?: string | null
  vehicle_description?: string | null
  job_notes?: string | null
}

export async function submitTuneJobDetails(jobId: string, distributorId: string, userId: string, d: TuneJobDetails): Promise<void> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, status').eq('id', jobId).maybeSingle()
  if (!job) throw new Error('Job not found')
  if (job.distributor_id !== distributorId) throw new Error('Job belongs to a different distributor')
  if (job.status !== 'awaiting_details') throw new Error(`Job is ${job.status}`)
  const name = String(d.customer_name || '').trim()
  if (!name) throw new Error('Customer name is required')

  const s = (v: any, n: number) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null }
  await c.from('b2b_tune_jobs').update({
    customer_name: name.slice(0, 200),
    customer_first_name: s(d.customer_first_name, 80),
    customer_phone: s(d.customer_phone, 40),
    customer_email: s(d.customer_email, 200),
    customer_address_line1: s(d.customer_address_line1, 200),
    customer_suburb: s(d.customer_suburb, 80),
    customer_state: s(d.customer_state, 10),
    customer_postcode: s(d.customer_postcode, 10),
    vehicle_rego: s(d.vehicle_rego, 20),
    vehicle_description: s(d.vehicle_description, 120),
    job_notes: s(d.job_notes, 1000),
    filled_by_user_id: userId, filled_at: new Date().toISOString(),
    status: 'submitted', updated_at: new Date().toISOString(),
  }).eq('id', jobId)

  // Queue the letter now (best-effort, logged into sync_error).
  // MechanicDesk customer+vehicle are created by the GH-Actions worker.
  try { await syncTuneJobDownstream(jobId) } catch (e: any) { console.error('tune-job sync failed:', e?.message) }
}

export async function syncTuneJobDownstream(jobId: string): Promise<void> {
  const c = sb()
  const { data: job } = await c.from('b2b_tune_jobs').select('*').eq('id', jobId).maybeSingle()
  if (!job || job.status !== 'submitted') return
  const { data: dist } = await c.from('b2b_distributors')
    .select('display_name, trading_name, primary_contact_email, ship_line1, ship_suburb, ship_state, ship_postcode')
    .eq('id', job.distributor_id).maybeSingle()
  const errs: string[] = []

  // Customer letter with the DISTRIBUTOR's details (printed at JA on the
  // existing letter agent). Uses the automation's default template body but
  // swaps the sign-off block for the distributor.
  if (!job.letter_queued_at && job.customer_address_line1) {
    try {
      const { getLetterAutomation, getTemplate, enqueueLetter } = await import('./workshop-letters')
      const auto = await getLetterAutomation()
      const template = auto.template_id ? await getTemplate(auto.template_id) : null
      if (template) {
        const distBlock = [
          dist?.display_name || '',
          [dist?.ship_line1, dist?.ship_suburb, dist?.ship_state, dist?.ship_postcode].filter(Boolean).join(' '),
          dist?.primary_contact_email || '',
        ].filter(Boolean).join('\n')
        const body = String(template.body || '')
          .replace(/\{\{\s*first_name\s*\}\}/g, job.customer_first_name || (job.customer_name || '').split(' ')[0] || 'there')
          .replace(/\{\{\s*vehicle\s*\}\}/g, job.vehicle_description || job.tune_details || 'your vehicle')
          .replace(/\{\{\s*rego\s*\}\}/g, job.vehicle_rego || '')
          + `\n\nYour local Just Autos distributor:\n${distBlock}`
        const address = [job.customer_address_line1, [job.customer_suburb, job.customer_state, job.customer_postcode].filter(Boolean).join(' ')].filter(Boolean).join('\n')
        const r = await enqueueLetter({
          trigger: 'auto',
          customer: { name: job.customer_name, first_name: job.customer_first_name, address },
          vehicle: job.vehicle_rego ? { rego: job.vehicle_rego, description: job.vehicle_description } : null,
          template,
          bodyOverride: body,
          recipientNameOverride: job.customer_name,
          recipientAddressOverride: address,
        })
        if (r.status === 'queued') {
          await c.from('b2b_tune_jobs').update({ letter_job_id: r.jobId || null, letter_queued_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', jobId)
        } else if (r.status === 'failed') {
          errs.push(`Letter: ${r.error || 'enqueue failed'}`)
        }
      } else {
        errs.push('Letter skipped: no default letter template configured')
      }
    } catch (e: any) { errs.push(`Letter: ${e?.message}`) }
  } else if (!job.letter_queued_at) {
    errs.push('Letter skipped: no customer address')
  }

  await c.from('b2b_tune_jobs').update({
    sync_error: errs.length ? errs.join(' | ').slice(0, 1000) : null,
    updated_at: new Date().toISOString(),
  }).eq('id', jobId)
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

// ── Weekly reminders ────────────────────────────────────────────────────

export async function sendTuneJobReminders(): Promise<{ distributors: number; jobs: number }> {
  const c = sb()
  const weekAgo = new Date(Date.now() - 6.5 * 24 * 3600_000).toISOString()
  const { data: jobs } = await c.from('b2b_tune_jobs')
    .select('id, distributor_id, vin, tune_details, last_reminder_at, created_at')
    .eq('status', 'awaiting_details')
    .not('distributor_id', 'is', null)
  const due = (jobs || []).filter(j => !j.last_reminder_at || j.last_reminder_at < weekAgo)
  const byDist = new Map<string, any[]>()
  for (const j of due) {
    const g = byDist.get(j.distributor_id) || []
    g.push(j); byDist.set(j.distributor_id, g)
  }
  let notified = 0
  for (const [distId, djobs] of Array.from(byDist.entries())) {
    try {
      const { data: dist } = await c.from('b2b_distributors')
        .select('display_name, primary_contact_email').eq('id', distId).maybeSingle()
      const { notifyDistributor } = await import('./push')
      await notifyDistributor(distId, {
        title: `${djobs.length} tune job${djobs.length === 1 ? '' : 's'} waiting on customer details`,
        body: 'Please fill in the customer details so we can finish the paperwork.',
        href: '/b2b/jobs',
        tag: `tune-job-reminder-${distId}`,
      })
      const to = (dist?.primary_contact_email || '').trim()
      if (to) {
        const { getFromMailbox } = await import('./b2b-settings')
        const rows = djobs.map(j => `<li>${j.tune_details || 'Tune'}${j.vin ? ` — VIN ${j.vin}` : ''} (received ${String(j.created_at).slice(0, 10)})</li>`).join('')
        await sendMail(await getFromMailbox(), {
          to: [to],
          subject: `Action needed: ${djobs.length} tune job${djobs.length === 1 ? '' : 's'} waiting on customer details`,
          html: `<p>Hi ${dist?.display_name || ''},</p><p>The following tune job${djobs.length === 1 ? ' is' : 's are'} waiting on customer details in your Just Autos portal:</p><ul>${rows}</ul><p><a href="https://justautos.app/b2b/jobs">Fill them in here</a> — it only takes a minute per job.</p><p>Thanks,<br/>Just Autos</p>`,
        })
      }
      await c.from('b2b_tune_jobs').update({ last_reminder_at: new Date().toISOString() })
        .in('id', djobs.map(j => j.id))
      notified++
    } catch (e: any) { console.error(`tune-job reminder failed for ${distId}:`, e?.message) }
  }
  return { distributors: notified, jobs: due.length }
}

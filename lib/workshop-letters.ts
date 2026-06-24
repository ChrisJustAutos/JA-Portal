// lib/workshop-letters.ts
// SERVER-ONLY orchestration for the Workshop Thank-You Letter automation.
//
//   • getLetterAutomation()        — singleton config (enabled / threshold / letterhead)
//   • enqueueLetter()              — render letter + DL envelope, upload to the
//                                    workshop-letters bucket, queue print jobs,
//                                    write a workshop_letter_jobs audit row
//   • maybeAutoLetterForBooking()  — the finalise hook entry point (auto trigger)
//
// Printing is handled by the existing label-print-agent: we insert
// label_print_jobs rows (kind='letter' / 'envelope', bucket='workshop-letters')
// and the agent on the workshop PC prints them to the office printer.

import fs from 'fs'
import path from 'path'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { renderLetterPdf, renderEnvelopePdf, LetterheadInfo } from './letter-pdf'
import { renderTemplate } from './workshop-comm-templates'
import { vehicleLabel, customerLabel } from './workshop'

const LETTER_BUCKET = 'workshop-letters'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Config ───────────────────────────────────────────────────────────────
export interface LetterAutomation {
  enabled: boolean
  min_total: number
  template_id: string | null
  print_envelope: boolean
  letterhead_name: string
  letterhead_abn: string | null
  letterhead_address: string | null
  letterhead_phone: string | null
  letterhead_email: string | null
  letterhead_website: string | null
  return_address: string | null
  watch_since: string | null   // ISO; only invoices on/after this fire (set on enable)
}

export async function getLetterAutomation(): Promise<LetterAutomation> {
  const { data } = await sb().from('workshop_letter_automation').select('*').eq('id', 'singleton').maybeSingle()
  return {
    enabled: data?.enabled ?? false,
    min_total: Number(data?.min_total ?? 0),
    template_id: data?.template_id ?? null,
    print_envelope: data?.print_envelope ?? true,
    letterhead_name: data?.letterhead_name ?? 'Just Autos',
    letterhead_abn: data?.letterhead_abn ?? null,
    letterhead_address: data?.letterhead_address ?? null,
    letterhead_phone: data?.letterhead_phone ?? null,
    letterhead_email: data?.letterhead_email ?? null,
    letterhead_website: data?.letterhead_website ?? null,
    return_address: data?.return_address ?? null,
    watch_since: data?.watch_since ?? null,
  }
}

export interface LetterTemplate {
  id: string
  name: string
  category: string | null
  body: string
  sign_off_name: string | null
  sign_off_title: string | null
}

export async function getTemplate(id: string): Promise<LetterTemplate | null> {
  const { data } = await sb().from('workshop_letter_templates').select('*').eq('id', id).maybeSingle()
  return (data as LetterTemplate) || null
}

export async function listTemplates(): Promise<LetterTemplate[]> {
  const { data } = await sb().from('workshop_letter_templates').select('*').order('sort_order').order('name')
  return (data as LetterTemplate[]) || []
}

export async function upsertTemplate(t: Partial<LetterTemplate> & { id?: string }): Promise<LetterTemplate> {
  const c = sb()
  const row: any = {
    name: t.name, category: t.category ?? null, body: t.body,
    sign_off_name: t.sign_off_name ?? null, sign_off_title: t.sign_off_title ?? null,
    updated_at: new Date().toISOString(),
  }
  if (t.id) {
    const { data, error } = await c.from('workshop_letter_templates').update(row).eq('id', t.id).select('*').single()
    if (error) throw new Error(error.message)
    return data as LetterTemplate
  }
  const { data, error } = await c.from('workshop_letter_templates').insert(row).select('*').single()
  if (error) throw new Error(error.message)
  return data as LetterTemplate
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await sb().from('workshop_letter_templates').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function setAutomation(patch: Partial<LetterAutomation>): Promise<LetterAutomation> {
  const current = await getLetterAutomation()
  const next: any = { ...patch, updated_at: new Date().toISOString() }
  // Switching ON stamps watch_since=now so the poller doesn't backfill every
  // recent MYOB invoice — only jobs finalised from here on get a letter.
  if (patch.enabled === true && (!current.enabled || !current.watch_since)) {
    next.watch_since = new Date().toISOString()
  }
  await sb().from('workshop_letter_automation').update(next).eq('id', 'singleton')
  return getLetterAutomation()
}

export async function listLetterJobs(limit = 100, offset = 0, includeSkipped = false): Promise<any[]> {
  let q = sb().from('workshop_letter_jobs')
    .select('*, template:workshop_letter_templates(name)')
    .order('created_at', { ascending: false })
  // 'skipped' rows are deposits / non-job invoices the poller examined and
  // deliberately didn't print — noise in the history view by default.
  if (!includeSkipped) q = q.neq('status', 'skipped')
  const { data } = await q.range(offset, offset + limit - 1)
  return data || []
}

// Record an invoice the poller examined but did NOT print (deposit / non-job /
// no-address) — so it's deduped and never re-examined. Idempotent on the MYOB
// UID via the partial unique index.
export async function recordLetterSkip(myobInvoiceUid: string, recipientName: string | null, invoiceTotal: number | null, reason: string): Promise<void> {
  await sb().from('workshop_letter_jobs').insert({
    trigger: 'auto', status: 'skipped', myob_invoice_uid: myobInvoiceUid,
    recipient_name: recipientName, invoice_total: invoiceTotal, error: reason,
  }).then(() => {}, () => {}) // unique-violation = already recorded; ignore
}

// UIDs already examined (printed or skipped) — lets the poller avoid re-fetching
// line detail for invoices it has already handled.
export async function lettersSeenUids(uids: string[]): Promise<Set<string>> {
  if (!uids.length) return new Set()
  const { data } = await sb().from('workshop_letter_jobs').select('myob_invoice_uid').in('myob_invoice_uid', uids)
  return new Set((data || []).map((r: any) => r.myob_invoice_uid).filter(Boolean))
}

// Fetch a workshop customer (+ most recent vehicle) for the manual composer.
export async function getCustomerForLetter(id: string): Promise<{ customer: any; vehicle: any | null } | null> {
  const c = sb()
  const { data: customer } = await c.from('workshop_customers').select('*').eq('id', id).maybeSingle()
  if (!customer) return null
  const { data: vehicle } = await c.from('workshop_vehicles').select('*').eq('customer_id', id).order('updated_at', { ascending: false }).limit(1).maybeSingle()
  return { customer, vehicle: vehicle || null }
}

// ── Letterhead helpers ─────────────────────────────────────────────────────
// Optional wordmark: drop a PNG/JPG at public/letterhead-logo.* and it gets
// embedded on the letter. Cached after first read (incl. the "missing" result).
let _logo: string | null | undefined
function logoDataUrl(): string | null {
  if (_logo !== undefined) return _logo
  for (const ext of ['png', 'jpg', 'jpeg']) {
    const p = path.join(process.cwd(), 'public', `letterhead-logo.${ext}`)
    try {
      if (fs.existsSync(p)) {
        const mime = ext === 'png' ? 'image/png' : 'image/jpeg'
        _logo = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`
        return _logo
      }
    } catch { /* ignore */ }
  }
  _logo = null
  return _logo
}

function letterhead(cfg: LetterAutomation): LetterheadInfo {
  return {
    name: cfg.letterhead_name,
    abn: cfg.letterhead_abn,
    address: cfg.letterhead_address,
    phone: cfg.letterhead_phone,
    email: cfg.letterhead_email,
    website: cfg.letterhead_website,
    logoDataUrl: logoDataUrl(),
  }
}

// Split a free-text address blob into display lines (newline-first, then comma).
export function addressLines(addr?: string | null): string[] {
  if (!addr) return []
  const byNewline = String(addr).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (byNewline.length > 1) return byNewline
  return String(addr).split(',').map(s => s.trim()).filter(Boolean)
}

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const firstNameOf = (c: any) => (c?.first_name || String(c?.name || '').trim().split(/\s+/)[0] || '').trim()

// ── Core enqueue ────────────────────────────────────────────────────────
export interface EnqueueLetterInput {
  trigger: 'auto' | 'manual'
  customer: any                 // workshop_customers row (name/first_name/address)
  vehicle?: any | null          // workshop_vehicles row (for {{vehicle}}/{{rego}})
  template: LetterTemplate
  bookingId?: string | null
  invoiceTotal?: number | null
  myobInvoiceUid?: string | null
  createdBy?: string | null
  // Optional overrides (manual composer): replace the rendered body/recipient.
  bodyOverride?: string | null
  recipientNameOverride?: string | null
  recipientAddressOverride?: string | null
}

export interface EnqueueResult { status: 'queued' | 'skipped' | 'failed'; jobId?: string; error?: string }

// Resolve recipient + rendered body from a customer/template (+ overrides).
// Shared by enqueueLetter() and the preview endpoint.
function composeLetterData(cfg: LetterAutomation, input: EnqueueLetterInput): { recipientName: string; recipientAddressLines: string[]; body: string } {
  const recipientName = (input.recipientNameOverride || customerLabel(input.customer) || input.customer?.name || 'Customer').trim()
  const recipientAddressLines = input.recipientAddressOverride
    ? addressLines(input.recipientAddressOverride)
    : addressLines(input.customer?.address)
  const vars: Record<string, string> = {
    first_name: firstNameOf(input.customer),
    customer_name: recipientName,
    vehicle: input.vehicle ? vehicleLabel(input.vehicle) : '',
    rego: input.vehicle?.rego ? String(input.vehicle.rego).toUpperCase() : '',
    date: new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' }),
    business_name: cfg.letterhead_name,
    total: input.invoiceTotal != null ? money(input.invoiceTotal) : '',
  }
  const body = input.bodyOverride != null ? input.bodyOverride : renderTemplate(input.template.body, vars)
  return { recipientName, recipientAddressLines, body }
}

// Render a one-off preview PDF (no DB writes) for the manual composer.
export async function renderLetterPreview(input: EnqueueLetterInput, kind: 'letter' | 'envelope'): Promise<Buffer> {
  const cfg = await getLetterAutomation()
  const { recipientName, recipientAddressLines, body } = composeLetterData(cfg, input)
  if (kind === 'envelope') {
    return renderEnvelopePdf({ recipientName, recipientAddressLines, returnAddressLines: addressLines(cfg.return_address) })
  }
  return renderLetterPdf({
    letterhead: letterhead(cfg), date: new Date().toISOString(),
    recipientName, recipientAddressLines, body,
    signOffName: input.template.sign_off_name, signOffTitle: input.template.sign_off_title,
  })
}

export async function enqueueLetter(input: EnqueueLetterInput): Promise<EnqueueResult> {
  const cfg = await getLetterAutomation()
  const c = sb()

  const { recipientName, recipientAddressLines, body } = composeLetterData(cfg, input)

  // 1) Audit row first — the partial unique index (booking_id WHERE trigger='auto')
  //    makes the auto path idempotent: a re-finalise / retry skips instead of
  //    double-printing.
  const ins = await c.from('workshop_letter_jobs').insert({
    booking_id: input.bookingId || null,
    customer_id: input.customer?.id || null,
    template_id: input.template.id,
    trigger: input.trigger,
    recipient_name: recipientName,
    recipient_address: recipientAddressLines.join('\n'),
    invoice_total: input.invoiceTotal ?? null,
    myob_invoice_uid: input.myobInvoiceUid || null,
    status: 'queued',
    created_by: input.createdBy || null,
  }).select('id').single()

  if (ins.error) {
    // 23505 = unique violation → an auto letter already exists for this booking.
    if ((ins.error as any).code === '23505') return { status: 'skipped' }
    return { status: 'failed', error: ins.error.message }
  }
  const jobId = ins.data.id as string

  try {
    // 2) Render PDFs.
    const letterPdf = await renderLetterPdf({
      letterhead: letterhead(cfg),
      date: new Date().toISOString(),
      recipientName,
      recipientAddressLines,
      body,
      signOffName: input.template.sign_off_name,
      signOffTitle: input.template.sign_off_title,
    })
    const letterPath = `letters/${jobId}.pdf`
    const up1 = await c.storage.from(LETTER_BUCKET).upload(letterPath, letterPdf, { contentType: 'application/pdf', upsert: true })
    if (up1.error) throw new Error(`letter upload: ${up1.error.message}`)

    let envelopePath: string | null = null
    if (cfg.print_envelope) {
      const envPdf = await renderEnvelopePdf({
        recipientName,
        recipientAddressLines,
        returnAddressLines: addressLines(cfg.return_address),
      })
      envelopePath = `envelopes/${jobId}.pdf`
      const up2 = await c.storage.from(LETTER_BUCKET).upload(envelopePath, envPdf, { contentType: 'application/pdf', upsert: true })
      if (up2.error) throw new Error(`envelope upload: ${up2.error.message}`)
    }

    // 3) Queue print jobs for the agent (letter first, then envelope).
    const printRows: any[] = [{ storage_path: letterPath, bucket: LETTER_BUCKET, kind: 'letter', status: 'pending' }]
    if (envelopePath) printRows.push({ storage_path: envelopePath, bucket: LETTER_BUCKET, kind: 'envelope', status: 'pending' })
    const pj = await c.from('label_print_jobs').insert(printRows)
    if (pj.error) throw new Error(`print queue: ${pj.error.message}`)

    // 4) Record paths on the audit row.
    await c.from('workshop_letter_jobs').update({ letter_storage_path: letterPath, envelope_storage_path: envelopePath }).eq('id', jobId)
    return { status: 'queued', jobId }
  } catch (e: any) {
    await c.from('workshop_letter_jobs').update({ status: 'failed', error: String(e?.message || e).slice(0, 500) }).eq('id', jobId)
    return { status: 'failed', jobId, error: String(e?.message || e) }
  }
}

// ── Finalise hook ─────────────────────────────────────────────────────────
// Called from createJobInvoiceInMyob() after the sale is pushed. Never throws —
// a letter failure must not break invoicing.
export async function maybeAutoLetterForBooking(
  bookingId: string,
  invoiceTotalIncGst: number,
  myobInvoiceUid: string | null,
): Promise<EnqueueResult | null> {
  try {
    const cfg = await getLetterAutomation()
    if (!cfg.enabled) return null
    if (!cfg.template_id) return null
    if (!(Number(invoiceTotalIncGst) >= Number(cfg.min_total))) return null

    const c = sb()
    // !customer_id hint avoids the dual-FK embed ambiguity (migration 121).
    const { data: booking } = await c.from('workshop_bookings')
      .select('id, customer:workshop_customers!customer_id(*), vehicle:workshop_vehicles(*)')
      .eq('id', bookingId).maybeSingle()
    const customer = (booking as any)?.customer
    if (!customer) return { status: 'skipped' }

    const template = await getTemplate(cfg.template_id)
    if (!template) return { status: 'skipped' }

    return await enqueueLetter({
      trigger: 'auto',
      customer,
      vehicle: (booking as any)?.vehicle || null,
      template,
      bookingId,
      invoiceTotal: invoiceTotalIncGst,
      myobInvoiceUid,
    })
  } catch (e: any) {
    console.error('[workshop-letters] auto letter failed:', e?.message || e)
    return { status: 'failed', error: String(e?.message || e) }
  }
}

// Re-queue the print jobs for an already-rendered letter (paths still in the
// workshop-letters bucket) — used by the history "Reprint" button.
export async function reprintLetter(jobId: string): Promise<EnqueueResult> {
  const c = sb()
  const { data: job } = await c.from('workshop_letter_jobs').select('letter_storage_path, envelope_storage_path').eq('id', jobId).maybeSingle()
  if (!job || !job.letter_storage_path) return { status: 'failed', error: 'No stored letter to reprint' }
  const rows: any[] = [{ storage_path: job.letter_storage_path, bucket: LETTER_BUCKET, kind: 'letter', status: 'pending' }]
  if (job.envelope_storage_path) rows.push({ storage_path: job.envelope_storage_path, bucket: LETTER_BUCKET, kind: 'envelope', status: 'pending' })
  const { error } = await c.from('label_print_jobs').insert(rows)
  if (error) return { status: 'failed', error: error.message }
  return { status: 'queued', jobId }
}

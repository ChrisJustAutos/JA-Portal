// agents/label-print-agent/index.js
//
// Self-hosted agent that auto-prints from the label_print_jobs queue. Runs on a
// workshop PC — the same pattern as the FreePBX agents. Handles four kinds:
//   label    → DYMO LabelWriter 4XL (B2B freight labels)
//   invoice  → office A4 printer (B2B invoices)
//   letter   → office printer (workshop thank-you letters, A4)
//   envelope → office printer (DL envelopes, printed at actual size)
//
// Flow: the portal inserts a row into label_print_jobs. This agent subscribes
// to that table via Supabase Realtime (service role), downloads the PDF from the
// row's bucket (b2b-shipping-labels for labels/invoices, workshop-letters for
// letters/envelopes), prints it to the right printer, and marks the job
// done/failed. It also polls on startup so jobs queued while it was offline get
// printed.
//
// Setup: see README.md. Requires Node 18+ (built-in fetch) and the DYMO printer
// installed in Windows with a known printer name.

try { require('dotenv').config() } catch { /* dotenv optional; env may be set by the service manager */ }
const os = require('os')
const path = require('path')
const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')
const printer = require('pdf-to-printer')

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PRINTER_NAME = process.env.DYMO_PRINTER_NAME || 'DYMO LabelWriter 4XL'
const BUCKET = process.env.LABEL_BUCKET || 'b2b-shipping-labels'
const POLL_MS = parseInt(process.env.POLL_MS || '30000', 10)
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '3', 10)
// Reclaim a job stuck in 'printing' this long — covers a PC that grabbed a job
// then crashed/was switched off mid-print (multi-PC setups).
const STALE_PRINTING_MS = parseInt(process.env.STALE_PRINTING_MS || '120000', 10)
const SCALE = process.env.PRINT_SCALE || 'fit' // 'fit' | 'noscale' | 'shrink'
// Invoices (kind='invoice') print to the office A4 printer, not the DYMO. If
// INVOICE_PRINTER_NAME is unset they go to the Windows default printer.
const INVOICE_PRINTER_NAME = process.env.INVOICE_PRINTER_NAME || ''
const INVOICE_SCALE = process.env.INVOICE_SCALE || 'fit'
// Thank-you letters (kind='letter', A4) + envelopes (kind='envelope', DL) print
// to the office printer too. Letters default to the invoice printer; envelopes
// default to the letter printer. Envelopes print at actual size ('noscale') so
// the DL page isn't rescaled — make sure that printer/tray holds DL envelopes.
const LETTER_PRINTER_NAME = process.env.LETTER_PRINTER_NAME || INVOICE_PRINTER_NAME || ''
const LETTER_SCALE = process.env.LETTER_SCALE || 'fit'
const ENVELOPE_PRINTER_NAME = process.env.ENVELOPE_PRINTER_NAME || LETTER_PRINTER_NAME || ''
const ENVELOPE_SCALE = process.env.ENVELOPE_SCALE || 'noscale'

// Per-kind print routing. Labels go to the DYMO; everything else to an office
// printer (falling back to the Windows default when its env var is unset).
function routeForKind(kind) {
  switch (kind) {
    case 'invoice':  return { printer: INVOICE_PRINTER_NAME,  scale: INVOICE_SCALE }
    case 'letter':   return { printer: LETTER_PRINTER_NAME,   scale: LETTER_SCALE }
    case 'envelope': return { printer: ENVELOPE_PRINTER_NAME, scale: ENVELOPE_SCALE }
    default:         return { printer: PRINTER_NAME,          scale: SCALE } // label → DYMO
  }
}
const destLabel = (kind) => (!kind || kind === 'label') ? PRINTER_NAME : (routeForKind(kind).printer || '(default printer)')

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see .env.example)')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const log = (...a) => console.log(new Date().toISOString(), ...a)

let working = false

async function claim(jobId) {
  // Atomic claim: only the row still 'pending' flips to 'printing'. With several
  // agents racing, Postgres row-locking means exactly one UPDATE matches — the
  // others get 0 rows back and skip. No duplicate prints.
  const { data } = await sb.from('label_print_jobs')
    .update({ status: 'printing', claimed_at: new Date().toISOString() })
    .eq('id', jobId).eq('status', 'pending')
    .select('id, storage_path, consignment_number, attempts, kind, bucket')
  return data && data.length ? data[0] : null
}

async function reclaimStale() {
  // Return jobs stuck in 'printing' (a PC died mid-print) back to the pool so
  // another on PC can retry. Bounded by MAX_ATTEMPTS via the failure path.
  const threshold = new Date(Date.now() - STALE_PRINTING_MS).toISOString()
  await sb.from('label_print_jobs')
    .update({ status: 'pending', error: 'reclaimed: previous printer went away mid-print' })
    .eq('status', 'printing').lt('claimed_at', threshold)
    .then(() => {}, () => {})
}

async function printJob(job) {
  // Short-lived signed URL → download the PDF → print → mark done. Letters and
  // envelopes live in their own bucket (job.bucket); labels/invoices in BUCKET.
  const bucket = job.bucket || BUCKET
  const { data: signed, error: signErr } = await sb.storage.from(bucket).createSignedUrl(job.storage_path, 120)
  if (signErr || !signed?.signedUrl) throw new Error(`signed url failed: ${signErr?.message || 'none'}`)

  const resp = await fetch(signed.signedUrl)
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) throw new Error('empty PDF')

  const kind = job.kind || 'label'
  const route = routeForKind(kind)
  const tmp = path.join(os.tmpdir(), `${kind}-${job.id}.pdf`)
  fs.writeFileSync(tmp, buf)
  try {
    const opts = { scale: route.scale }
    if (route.printer) opts.printer = route.printer
    await printer.print(tmp, opts)
  } finally {
    fs.unlink(tmp, () => {})
  }
}

async function handleJob(job) {
  const claimed = await claim(job.id)
  if (!claimed) return // already taken
  log(`printing ${claimed.kind || 'label'} job ${claimed.id} (consignment ${claimed.consignment_number || '—'}) → ${destLabel(claimed.kind)}`)
  try {
    await printJob(claimed)
    await sb.from('label_print_jobs').update({ status: 'done', printed_at: new Date().toISOString(), error: null, attempts: (claimed.attempts || 0) + 1 }).eq('id', claimed.id)
    log(`  ✓ printed ${claimed.id}`)
  } catch (e) {
    const attempts = (claimed.attempts || 0) + 1
    const giveUp = attempts >= MAX_ATTEMPTS
    await sb.from('label_print_jobs').update({ status: giveUp ? 'failed' : 'pending', attempts, error: String(e && e.message || e).slice(0, 500) }).eq('id', claimed.id)
    log(`  ✗ print failed for ${claimed.id} (attempt ${attempts}${giveUp ? ', giving up' : ', will retry'}): ${e && e.message || e}`)
  }
}

async function drainPending() {
  if (working) return
  working = true
  try {
    await reclaimStale()
    const { data, error } = await sb.from('label_print_jobs').select('id, storage_path, consignment_number, attempts, kind, bucket').eq('status', 'pending').order('created_at', { ascending: true }).limit(20)
    if (error) { log('poll error:', error.message); return }
    for (const job of data || []) await handleJob(job)
  } finally { working = false }
}

async function main() {
  log(`Print agent starting — labels→"${PRINTER_NAME}", invoices→"${INVOICE_PRINTER_NAME || '(default printer)'}", letters→"${LETTER_PRINTER_NAME || '(default printer)'}", envelopes→"${ENVELOPE_PRINTER_NAME || '(default printer)'}", bucket="${BUCKET}"`)
  // Confirm the printer exists (best-effort; warn but keep running).
  try {
    const printers = await printer.getPrinters()
    const found = printers.find(p => (p.name || p.deviceId || '').toLowerCase() === PRINTER_NAME.toLowerCase())
    if (!found) log(`WARNING: printer "${PRINTER_NAME}" not found. Installed: ${printers.map(p => p.name).join(', ') || 'none'}`)
  } catch (e) { log('Could not list printers (continuing):', e && e.message) }

  await drainPending()

  // Realtime: print as jobs arrive.
  sb.channel('label-print-jobs')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'label_print_jobs' }, (payload) => {
      log(`new job ${payload.new && payload.new.id}`)
      drainPending().catch(e => log('drain error:', e && e.message))
    })
    .subscribe((status) => log('realtime:', status))

  // Poll fallback in case a realtime event is missed.
  setInterval(() => drainPending().catch(e => log('poll drain error:', e && e.message)), POLL_MS)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })

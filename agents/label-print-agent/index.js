// agents/label-print-agent/index.js
//
// Self-hosted agent that auto-prints B2B freight labels to the workshop DYMO
// LabelWriter 4XL. Runs on the workshop PC (the one the DYMO is attached to) —
// the same pattern as the FreePBX agents.
//
// Flow: the portal inserts a row into label_print_jobs when a MachShip label is
// stored. This agent subscribes to that table via Supabase Realtime (service
// role), downloads the label PDF from the b2b-shipping-labels bucket, prints it
// to the DYMO, and marks the job done/failed. It also polls on startup so any
// jobs queued while it was offline get printed.
//
// Setup: see README.md. Requires Node 18+ (built-in fetch) and the DYMO printer
// installed in Windows with a known printer name.

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
const SCALE = process.env.PRINT_SCALE || 'fit' // 'fit' | 'noscale' | 'shrink'

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see .env.example)')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const log = (...a) => console.log(new Date().toISOString(), ...a)

let working = false

async function claim(jobId) {
  // Atomic claim: only the row still 'pending' flips to 'printing'.
  const { data } = await sb.from('label_print_jobs')
    .update({ status: 'printing' })
    .eq('id', jobId).eq('status', 'pending')
    .select('id, storage_path, consignment_number, attempts')
  return data && data.length ? data[0] : null
}

async function printJob(job) {
  // Short-lived signed URL → download the PDF → print → mark done.
  const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUrl(job.storage_path, 120)
  if (signErr || !signed?.signedUrl) throw new Error(`signed url failed: ${signErr?.message || 'none'}`)

  const resp = await fetch(signed.signedUrl)
  if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  if (buf.length === 0) throw new Error('empty label PDF')

  const tmp = path.join(os.tmpdir(), `label-${job.id}.pdf`)
  fs.writeFileSync(tmp, buf)
  try {
    await printer.print(tmp, { printer: PRINTER_NAME, scale: SCALE })
  } finally {
    fs.unlink(tmp, () => {})
  }
}

async function handleJob(job) {
  const claimed = await claim(job.id)
  if (!claimed) return // already taken
  log(`printing job ${claimed.id} (consignment ${claimed.consignment_number || '—'}) → ${PRINTER_NAME}`)
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
    const { data, error } = await sb.from('label_print_jobs').select('id, storage_path, consignment_number, attempts').eq('status', 'pending').order('created_at', { ascending: true }).limit(20)
    if (error) { log('poll error:', error.message); return }
    for (const job of data || []) await handleJob(job)
  } finally { working = false }
}

async function main() {
  log(`Label print agent starting — printer="${PRINTER_NAME}", bucket="${BUCKET}"`)
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

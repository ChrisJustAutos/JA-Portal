// scripts/check-vin-series.ts
//
// Validates seriesFromVin() against the two independent VIN populations we
// have, and proves it agrees with a signal it cannot see.
//
//   1. b2b_tune_jobs — has a VIN *and* free-text `tune_details` written by the
//      tuner ("79_V4.223_MM", "PRADO_GEN3", "200_60U8E", "N80 48V", "300 Gen 4").
//      That text is an INDEPENDENT statement of the model, so agreement between
//      it and the VIN decode is real evidence, not a tautology.
//   2. distributors_cache — the PO-number VINs that actually feed the report.
//      No independent label here, so the check is coverage: how many decode,
//      and what the unknown tail looks like.
//
// Prints disagreements and the unknown tail in full: a VIN decoder that
// silently buckets everything as OTH would still "pass" a count-only check.
//
// Run: npx tsx scripts/check-vin-series.ts

import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { seriesFromVin, isVin, normaliseVin } from '../lib/workshop-map/vehicle-classification'

// Read .env.local directly — this is a local diagnostic, and there is no dotenv
// in the tree. Handles quoted values and CRLF line endings.
function envLocal(key: string): string {
  if (process.env[key]) return process.env[key] as string
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
    for (const raw of txt.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(raw.trim())
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch { /* fall through */ }
  return ''
}

const URL = envLocal('NEXT_PUBLIC_SUPABASE_URL')
const KEY = envLocal('SUPABASE_SERVICE_ROLE_KEY')
if (!URL || !KEY) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required (env or .env.local)')
const db = createClient(URL, KEY, { auth: { persistSession: false } })

/** What the tuner's own words say the model is — independent of the VIN. */
function seriesFromTuneText(text?: string | null): string | null {
  const t = (text || '').toUpperCase()
  if (/\b(300|LC300)\b|GEN\s*4/.test(t) && !/\b250\b/.test(t)) return '300'
  if (/\b200\b|60[A-Z0-9]{3}_200|200_/.test(t)) return '200'
  if (/\b(79|78|76|70)\b|GDJ|VDJ|79_/.test(t)) return '70'
  if (/PRADO|\b250\b|\b150\b/.test(t)) return 'PRADO'
  if (/\bN80\b|HILUX|FAF2E|FAL50/.test(t)) return 'HILUX'
  return null
}

async function main() {
  // ── 1. tune jobs: VIN decode vs the tuner's text ───────────────────────
  const { data: tj, error } = await db.from('b2b_tune_jobs').select('vin, tune_details').limit(2000)
  if (error) throw new Error(error.message)

  let agree = 0, disagree = 0, noText = 0, notVin = 0, oth = 0
  const mismatches: string[] = []
  const othVins: string[] = []
  for (const r of tj || []) {
    const vin = normaliseVin(r.vin)
    if (!isVin(vin)) { notVin++; continue }
    const got = seriesFromVin(vin)
    if (got === 'OTH') { oth++; if (othVins.length < 20) othVins.push(`${vin}  «${(r.tune_details || '').slice(0, 40)}»`) }
    const want = seriesFromTuneText(r.tune_details)
    if (!want) { noText++; continue }
    if (want === got) agree++
    else {
      disagree++
      if (mismatches.length < 25) mismatches.push(`${vin}  vin→${got}  text→${want}   «${(r.tune_details || '').slice(0, 46)}»`)
    }
  }

  console.log('=== b2b_tune_jobs: VIN decode vs the tuner\'s own words ===')
  console.log(`  rows                : ${(tj || []).length}`)
  console.log(`  not a valid VIN     : ${notVin}`)
  console.log(`  no model in text    : ${noText}  (cannot be cross-checked)`)
  console.log(`  AGREE               : ${agree}`)
  console.log(`  DISAGREE            : ${disagree}`)
  console.log(`  decoded as OTH      : ${oth}`)
  const checked = agree + disagree
  console.log(`  agreement rate      : ${checked ? ((100 * agree) / checked).toFixed(1) : '—'}%  (of ${checked} cross-checkable)`)
  if (mismatches.length) { console.log('\n  mismatches:'); mismatches.forEach(m => console.log('   ', m)) }
  if (othVins.length) { console.log('\n  decoded OTH (unrecognised — these are the tail to watch):'); othVins.forEach(m => console.log('   ', m)) }

  // ── 2. distributor PO numbers: coverage ────────────────────────────────
  const { data: caches } = await db.from('distributors_cache').select('range_key, payload').in('range_key', ['FY2026', 'FY2027'])
  const seen = new Map<string, string>()   // vin → series
  let poTotal = 0, poLen17 = 0, poNotVin = 0
  for (const c of caches || []) {
    for (const d of ((c.payload as any)?.distributors || [])) {
      for (const li of (d.lineItems || [])) {
        const raw = String(li.poNumber || '').trim()
        if (!raw) continue
        poTotal++
        if (raw.length !== 17) continue
        poLen17++
        const vin = normaliseVin(raw)
        if (!isVin(vin)) { poNotVin++; continue }
        seen.set(vin, seriesFromVin(vin) || 'OTH')
      }
    }
  }
  const dist: Record<string, number> = {}
  for (const s of Array.from(seen.values())) dist[s] = (dist[s] || 0) + 1
  console.log('\n=== distributor PO numbers (FY2026 + FY2027) ===')
  console.log(`  line items with a PO    : ${poTotal}`)
  console.log(`  PO exactly 17 chars     : ${poLen17}`)
  console.log(`  …of those, not a VIN    : ${poNotVin}  (17-char text like "GREG CANNON / STK")`)
  console.log(`  distinct VINs           : ${seen.size}`)
  console.log('  series split            :', JSON.stringify(dist))
  const othList = Array.from(seen.entries()).filter(([, s]) => s === 'OTH').map(([v]) => v)
  const pctOth = seen.size ? (100 * othList.length) / seen.size : 0
  console.log(`  unrecognised (OTH)      : ${othList.length}  (${pctOth.toFixed(1)}%)`)
  if (othList.length) console.log('   ', othList.slice(0, 30).join(', '))

  // Gate: the decoder is only useful if it agrees with the independent text and
  // leaves a small tail. Both thresholds are deliberately strict.
  const ok = (checked === 0 || (100 * agree) / checked >= 97) && pctOth <= 5
  console.log('\n' + (ok ? 'PASS' : 'FAIL') + ` — agreement ${checked ? ((100 * agree) / checked).toFixed(1) : 'n/a'}%, unrecognised ${pctOth.toFixed(1)}%`)
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('check failed:', e?.message || e); process.exit(1) })

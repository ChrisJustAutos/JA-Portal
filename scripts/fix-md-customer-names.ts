// scripts/fix-md-customer-names.ts
//
// One-off repair for the 12 customers created 2026-07-13 by the first
// Monday→MD import run: MD accepted POST /customers but silently dropped
// first_name/last_name (record shows number + mobile + email only).
//
// Discovers the update-body shape MD actually honours by trying, on the
// first customer: (a) flat JSON, (b) Rails-nested {customer:{...}},
// (c) GET-merge-PUT of the full object — verifying each with a read-back.
// The winning shape is applied to all customers, with names title-cased
// (when ALL-CAPS) and mobiles formatted "#### ### ###" per Chris.
//
// Prints the winning shape so createMdCustomer can be fixed to match.

import { loginToMechanicDesk, mdRequest, type MdClient } from '../lib/mechanicdesk-stocktake'

const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')

const CUSTOMERS: { id: number; name: string; mobile: string | null; postcode: string | null }[] = [
  { id: 16145618, name: 'ARRON BURFURD', mobile: '0466427207', postcode: null },
  { id: 16145621, name: 'Luke Daley', mobile: '0487926664', postcode: '2829' },
  { id: 16145622, name: 'Brett Paxman', mobile: '0401721778', postcode: '4160' },
  { id: 16145623, name: 'Adam Boyd', mobile: '+61 427 220 970', postcode: '6010' },
  { id: 16145624, name: 'Michael Connolly', mobile: '0487612694', postcode: '2648' },
  { id: 16145627, name: 'Zak Khaliq', mobile: '0403553885', postcode: '6055' },
  { id: 16145630, name: 'Jarrod Dempsey', mobile: '0410627904', postcode: '2745' },
  { id: 16145634, name: 'Jackson', mobile: '0409284463', postcode: '6714' },
  { id: 16145635, name: 'Jason Harker', mobile: '0407447007', postcode: '4814' },
  { id: 16145636, name: 'Jay Dominguez', mobile: '+639615284627', postcode: '4114' },
  { id: 16145641, name: 'John Grant', mobile: '0427989221', postcode: '6121' },
  { id: 16145643, name: 'Mick', mobile: '0419950681', postcode: '6168' },
]

function titleIfCaps(s: string): string {
  if (s !== s.toUpperCase()) return s
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

export function fmtMobile(raw: string | null): string | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, '')
  if (d.startsWith('61') && d.length === 11) d = '0' + d.slice(2)
  if (d.length === 10 && d.startsWith('04')) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`
  return String(raw).trim() || null
}

// Customer #40462 leftovers from the first repair attempt must not survive.
function cleanupNoise(s: string): string {
  return s.replace(/Customer #\d+/gi, '').trim() || s
}

async function readNames(client: MdClient, id: number): Promise<{ first: string | null; last: string | null; mobile: string | null }> {
  const c = await mdRequest<any>(client, `/customers/${id}.json`)
  const cust = c?.customer ?? c
  return { first: cust?.first_name || null, last: cust?.last_name || null, mobile: cust?.mobile || null }
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const { client } = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    console.log('MD login ok')

    // Discovery from the first repair attempt (run 29217622760): MD ignores
    // first_name/last_name on writes and instead SPLITS the `name` field
    // itself (the merged probe set name "Customer #40462" → first "Customer",
    // last "#40462"). So: send { name, mobile } and let MD do the split.
    for (const cust of CUSTOMERS) {
      const display = titleIfCaps(cleanupNoise(cust.name))
      const body = { name: display, mobile: fmtMobile(cust.mobile) }
      await mdRequest(client, `/customers/${cust.id}`, { method: 'PUT', body: JSON.stringify(body) })
      const after = await readNames(client, cust.id)
      const gotName = [after.first, after.last].filter(Boolean).join(' ')
      const ok = gotName.toLowerCase() === display.toLowerCase()
      console.log(`${ok ? '✓' : '✗'} #${cust.id} want "${display}" got "${gotName}" — mobile ${after.mobile}`)
      if (!ok) process.exitCode = 1
    }
    console.log('repair complete')
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })

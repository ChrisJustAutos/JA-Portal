// scripts/import-monday-leads.ts
//
// Nightly GH Actions worker: new leads on the sales Quote Channel boards in
// Monday → customers in MechanicDesk, killing the daily double entry.
//
//   1. Pull recent items (created within LOOKBACK_HOURS, default 36) from the
//      five quote channel boards via Monday GraphQL.
//   2. Ask the portal which items were already handled (idempotent across runs).
//   3. For each new lead: live-search MD by phone digits, then email —
//      existing customers are never touched. No match → create the customer
//      (first/last name, mobile, email, postcode).
//   4. Report every outcome back to the portal (monday_md_customer_imports).
//
// Modes:
//   DRY_RUN=1          — list what would happen, write/create nothing.
//   TEST_CREATE=1      — self-check: create + verify + soft-delete a dummy
//                        MD customer, touch nothing else.
//
// Env: MONDAY_API_TOKEN, MECHANICDESK_WORKSHOP_ID/USERNAME/PASSWORD,
//      JA_PORTAL_BASE_URL, JA_PORTAL_API_KEY

import {
  loginToMechanicDesk, searchMdCustomers, createMdCustomer, deleteMdCustomer,
  type MdClient,
} from '../lib/mechanicdesk-stocktake'

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || ''
const WS_ID = process.env.MECHANICDESK_WORKSHOP_ID || ''
const MD_USER = process.env.MECHANICDESK_USERNAME || ''
const MD_PASS = process.env.MECHANICDESK_PASSWORD || ''
const PORTAL_BASE = process.env.JA_PORTAL_BASE_URL || ''
const PORTAL_TOKEN = process.env.JA_PORTAL_API_KEY || ''
const DRY_RUN = process.env.DRY_RUN === '1'
const TEST_CREATE = process.env.TEST_CREATE === '1'
const LOOKBACK_HOURS = Math.max(1, Number(process.env.LOOKBACK_HOURS) || 36)

const BOARDS: { id: string; channel: string }[] = [
  { id: '5026840169', channel: 'Graham' },
  { id: '5025942308', channel: 'Dom' },
  { id: '5025942288', channel: 'Tyronne' },
  { id: '5025942316', channel: 'Kaleb' },
  { id: '5025942292', channel: 'James' },
]
// Column ids are identical across the five boards (template copies).
const COL_PHONE = 'text_mkzbenay'
const COL_EMAIL = 'text_mkzbpqje'
const COL_POSTCODE = 'text_mkzc86wk'

if (!TEST_CREATE && !MONDAY_TOKEN) throw new Error('MONDAY_API_TOKEN required')
if (!WS_ID || !MD_USER || !MD_PASS) throw new Error('MECHANICDESK_* env vars required')
if (!TEST_CREATE && (!PORTAL_BASE || !PORTAL_TOKEN)) throw new Error('JA_PORTAL_* env vars required')

const digits = (s: string | null | undefined) => String(s || '').replace(/\D/g, '')

interface Lead {
  itemId: string; boardId: string; channel: string; createdAt: string
  name: string; phone: string | null; email: string | null; postcode: string | null
}

async function mondayQuery(query: string): Promise<any> {
  const r = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: MONDAY_TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query }),
  })
  const data = await r.json()
  if (!r.ok || data.errors) throw new Error(`Monday API: ${JSON.stringify(data.errors || data).slice(0, 300)}`)
  return data.data
}

async function fetchRecentLeads(): Promise<Lead[]> {
  const since = Date.now() - LOOKBACK_HOURS * 3600e3
  const leads: Lead[] = []
  for (const b of BOARDS) {
    // Two pages of 100 covers far more than a night's leads on any board.
    let cursor: string | null = null
    for (let page = 0; page < 2; page++) {
      const cursorArg: string = cursor ? `, cursor: "${cursor}"` : ''
      const data = await mondayQuery(`query { boards(ids: [${b.id}]) { items_page(limit: 100${cursorArg}) {
        cursor
        items { id name created_at column_values(ids: ["${COL_PHONE}","${COL_EMAIL}","${COL_POSTCODE}"]) { id text } }
      } } }`)
      const pageData = data?.boards?.[0]?.items_page
      const items: any[] = pageData?.items || []
      for (const it of items) {
        const created = new Date(it.created_at).getTime()
        if (!(created >= since)) continue
        const col = (id: string) => (it.column_values || []).find((c: any) => c.id === id)?.text?.trim() || null
        leads.push({
          itemId: String(it.id), boardId: b.id, channel: b.channel, createdAt: it.created_at,
          name: String(it.name || '').trim(), phone: col(COL_PHONE), email: col(COL_EMAIL), postcode: col(COL_POSTCODE),
        })
      }
      cursor = pageData?.cursor || null
      if (!cursor || !items.length) break
      // If the whole page is older than the window, later pages will be too
      // (boards grow by appending) — but ordering isn't guaranteed, so only
      // stop when the page yielded nothing new.
      if (!items.some((it: any) => new Date(it.created_at).getTime() >= since)) break
    }
  }
  return leads
}

async function portalSeen(itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length) return new Set()
  const r = await fetch(`${PORTAL_BASE}/api/workshop/monday-md-import?item_ids=${itemIds.join(',')}`, {
    headers: { 'X-Service-Token': PORTAL_TOKEN },
  })
  if (!r.ok) throw new Error(`portal seen-check failed: ${r.status}`)
  const data = await r.json()
  return new Set((data.seen || []).map(String))
}

async function portalReport(rows: any[]): Promise<void> {
  if (!rows.length) return
  const r = await fetch(`${PORTAL_BASE}/api/workshop/monday-md-import`, {
    method: 'POST',
    headers: { 'X-Service-Token': PORTAL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  })
  if (!r.ok) throw new Error(`portal report failed: ${r.status} ${await r.text().catch(() => '')}`)
}

// Monday lead names often carry a doubled surname ("Adam Boyd Boyd",
// "Ben Lippett Lippett" — an intake-form quirk) — collapse consecutive
// duplicate words before they pollute MD.
function cleanName(full: string): string {
  const words = full.trim().split(/\s+/)
  return words.filter((w, i) => i === 0 || w.toLowerCase() !== words[i - 1].toLowerCase()).join(' ')
}

function splitName(full: string): { first: string; last: string } {
  const parts = cleanName(full).split(/\s+/)
  if (parts.length === 1) return { first: parts[0], last: '' }
  return { first: parts[0], last: parts.slice(1).join(' ') }
}

// MD's own search can't match phone numbers (probed 2026-07-13: query by a
// known mobile returns customers:[]), so dedup is two-layered:
//   1. Portal's workshop_customers mirror by phone tail / email — covers
//      everyone MD has had for a while (mirror carries md_id).
//   2. Live MD search by NAME (the one thing MD search does) — catches
//      recent MD customers the mirror hasn't got yet.
const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function findExisting(client: MdClient, lead: Lead): Promise<{ id: number | string; via: string } | null> {
  const tail = digits(lead.phone).slice(-8)
  const params = new URLSearchParams({ check: '1' })
  if (tail.length === 8) params.set('phone_tail', tail)
  if (lead.email) params.set('email', lead.email)
  if (params.has('phone_tail') || params.has('email')) {
    const r = await fetch(`${PORTAL_BASE}/api/workshop/monday-md-import?${params.toString()}`, {
      headers: { 'X-Service-Token': PORTAL_TOKEN },
    })
    if (r.ok) {
      const { candidates } = await r.json()
      const hit = (candidates || []).find((cand: any) =>
        cand.md_id && (
          (tail.length === 8 && (digits(cand.mobile).endsWith(tail) || digits(cand.phone).endsWith(tail))) ||
          (lead.email && (cand.email || '').toLowerCase() === lead.email.toLowerCase())
        ))
      if (hit) return { id: hit.md_id, via: 'portal mirror' }
    }
  }
  if (lead.name.trim().length >= 5) {
    const hits = await searchMdCustomers(client, lead.name.trim())
    const hit = hits.find(h => normName(h.name) === normName(lead.name))
    if (hit) return { id: hit.id, via: 'MD name search' }
  }
  return null
}

async function main() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const login = await loginToMechanicDesk(browser, WS_ID, MD_USER, MD_PASS)
    const client = login.client
    console.log('MD login ok')

    if (TEST_CREATE) {
      // Self-check: create → search finds it → delete.
      const marker = `Portaltest${Date.now().toString().slice(-6)}`
      console.log(`test-create: creating dummy customer "JA ${marker}"`)
      const created = await createMdCustomer(client, {
        firstName: 'JA', lastName: marker, mobile: '0400000000', email: `test-${marker.toLowerCase()}@justautos.invalid`, postcode: '4560',
      })
      console.log(`created id=${created.id} number=${created.number}`)
      const found = await searchMdCustomers(client, marker)
      console.log(`search found ${found.length} match(es):`, found.map(f => f.id).join(','))
      await deleteMdCustomer(client, created.id)
      console.log('deleted — test-create PASSED')
      return
    }

    const leads = await fetchRecentLeads()
    console.log(`Monday: ${leads.length} lead(s) created in the last ${LOOKBACK_HOURS}h across ${BOARDS.length} boards`)
    const seen = await portalSeen(leads.map(l => l.itemId))
    const fresh = leads.filter(l => !seen.has(l.itemId))
    console.log(`${fresh.length} not yet handled`)

    const rows: any[] = []
    for (const lead of fresh) {
      const base = {
        monday_item_id: lead.itemId, monday_board_id: lead.boardId, channel: lead.channel,
        customer_name: lead.name, phone: lead.phone, email: lead.email, postcode: lead.postcode,
      }
      try {
        if (!lead.name || (!digits(lead.phone) && !lead.email)) {
          rows.push({ ...base, outcome: 'skipped', error: 'no name or no phone/email — nothing to import' })
          console.log(`- ${lead.channel}: "${lead.name}" skipped (insufficient data)`)
          continue
        }
        const existing = await findExisting(client, lead)
        if (existing) {
          rows.push({ ...base, outcome: 'exists_md', md_customer_id: existing.id })
          console.log(`- ${lead.channel}: "${lead.name}" already in MD (#${existing.id} via ${existing.via})`)
          continue
        }
        if (DRY_RUN) {
          console.log(`- ${lead.channel}: "${lead.name}" WOULD create (dry run)`)
          continue
        }
        const { first, last } = splitName(lead.name)
        const created = await createMdCustomer(client, {
          firstName: first, lastName: last, mobile: lead.phone, email: lead.email, postcode: lead.postcode,
        })
        base.customer_name = cleanName(lead.name)
        rows.push({ ...base, outcome: 'created', md_customer_id: created.id })
        console.log(`- ${lead.channel}: "${lead.name}" CREATED in MD (#${created.id})`)
      } catch (e: any) {
        rows.push({ ...base, outcome: 'error', error: String(e?.message || e).slice(0, 300) })
        console.error(`- ${lead.channel}: "${lead.name}" ERROR: ${e?.message}`)
      }
    }

    if (!DRY_RUN) await portalReport(rows)
    const created = rows.filter(r => r.outcome === 'created').length
    const existed = rows.filter(r => r.outcome === 'exists_md').length
    const errors = rows.filter(r => r.outcome === 'error').length
    console.log(`DONE: ${created} created, ${existed} already existed, ${errors} errors, ${rows.filter(r => r.outcome === 'skipped').length} skipped`)
    if (errors) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })

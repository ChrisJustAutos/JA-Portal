// lib/ac-won-from-myob.ts
// Mark an ActiveCampaign deal Quote Won when its customer's invoice reaches
// MYOB — and bring the customer's details back into the AC contact while
// we're there.
//
// WHY MYOB RATHER THAN THE MD CACHE (Chris, 2026-09-04)
// A finalised MD invoice is pushed to MYOB, so MYOB is the accounting system
// of record and two things follow:
//   - COMPLETENESS: an invoice in MYOB really was finalised. The md_invoices
//     table is a once-daily scrape and only proves the row existed then.
//   - A REAL JOIN KEY. This is the important one. MD's caches carry no email
//     at all — customer_name is the best they offer — but a MYOB customer
//     card carries Addresses[].Email, and an AC contact is keyed on email.
//     So MYOB turns a fuzzy name/rego inference into an identity match.
//
// The md_invoices route in lib/ac-deal-sweep.ts stays as the fallback for
// customers whose MYOB card has no email on it.
//
// THE CHAIN
//     MYOB Sale/Invoice --Customer.UID--> customer card --Email-->
//     AC contact (exact) --> that contact's OPEN group-6 deals --> Quote Won
//
// Only the last hop involves a choice, and only when one contact has several
// open deals: we prefer the deal whose value sits inside the invoice's value
// band, then the most recently created. Which rule fired is written onto the
// deal note, so a wrong pick is always explainable after the fact.
//
// WHAT IT WRITES BACK. Chris asked for the customer's details to update the
// contact as well. We only ever FILL EMPTY FIELDS — never overwrite what AC
// already holds. A workshop card is often staler than the marketing record
// (an old landline, a business name in place of a person's), so treating
// MYOB as authoritative would degrade the contact rather than enrich it.
//
// DRY BY DEFAULT, like every other pass here. Nothing moves until
// AC_SWEEP_MYOB_WON_LIVE=true.

import { fetchSaleInvoices } from './myob-reporting'
import { myobFetch } from './myob'
import { findByEmail } from './activecampaign'
import { AC_GROUP, STAGE_QUOTE_WON } from './ac-deal-sweep'

const DEAL_STATUS_OPEN = 0
const DEAL_STATUS_WON = 1

export const MYOB_WON_LOOKBACK_DAYS = Number(process.env.AC_SWEEP_MYOB_LOOKBACK_DAYS || 7)
export const MYOB_WON_MIN_RATIO = Number(process.env.AC_SWEEP_MYOB_MIN_RATIO || 0.5)
export const MYOB_WON_MAX_RATIO = Number(process.env.AC_SWEEP_MYOB_MAX_RATIO || 3)

export function myobWonIsLive(): boolean {
  return (process.env.AC_SWEEP_MYOB_WON_LIVE || '').toLowerCase() === 'true'
}

function acFetch(path: string, opts: RequestInit = {}) {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) throw new Error('ACTIVECAMPAIGN_API_URL / ACTIVECAMPAIGN_API_KEY not set')
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    ...opts,
    headers: {
      'Api-Token': apiKey, 'Content-Type': 'application/json', Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
}

async function acJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await acFetch(path, opts)
  if (!r.ok) throw new Error(`AC ${r.status} on ${path}: ${(await r.text()).substring(0, 300)}`)
  return r.json()
}

// ── MYOB customer cards ──────────────────────────────────────────────────

export interface MyobCustomer {
  uid: string
  name: string
  email: string | null
  phone: string | null
  postcode: string | null
  city: string | null
  state: string | null
}

function pickAddress(addrs: any[]): any | null {
  if (!Array.isArray(addrs) || addrs.length === 0) return null
  // Addresses[0] is MYOB's primary "Bill To". Prefer the first that actually
  // carries an email — a card whose primary address is a PO box with the
  // contactable address second is common, and the same pattern bites the AP
  // lookup (lib/ap-myob-lookup.ts).
  return addrs.find(a => String(a?.Email || '').trim()) || addrs[0]
}

/**
 * Every VPS customer card, indexed by UID. One paged read per run rather
 * than a card fetch per invoice — a day's invoices routinely repeat the
 * same customers, and the card list is small enough to hold.
 */
export async function fetchCustomerCards(companyFileId: string, connId: string): Promise<Map<string, MyobCustomer>> {
  const out = new Map<string, MyobCustomer>()
  let skip = 0
  const PAGE = 400
  while (skip < 40000) {
    const r = await myobFetch(connId, `/accountright/${companyFileId}/Contact/Customer`, {
      query: { '$top': PAGE, '$skip': skip },
    })
    if (r.status !== 200) throw new Error(`MYOB Contact/Customer: HTTP ${r.status}`)
    const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
    if (items.length === 0) break
    for (const c of items) {
      const addr = pickAddress(c.Addresses)
      const name = (c.CompanyName || `${c.FirstName || ''} ${c.LastName || ''}`.trim() || '').trim()
      out.set(String(c.UID), {
        uid: String(c.UID),
        name,
        email: (addr?.Email || '').trim() || null,
        phone: (addr?.Phone1 || addr?.Phone2 || '').trim() || null,
        postcode: addr?.PostCode ? String(addr.PostCode) : null,
        city: addr?.City || null,
        state: addr?.State || null,
      })
    }
    if (items.length < PAGE) break
    skip += PAGE
  }
  return out
}

// ── AC deals for one contact ─────────────────────────────────────────────

interface ACOpenDeal {
  id: string
  title: string
  value: number
  cdate: string
}

async function openDealsForContact(contactId: number): Promise<ACOpenDeal[]> {
  const data = await acJson<{ deals: any[] }>(`/deals?filters[contact]=${contactId}&orders[cdate]=DESC&limit=50`)
  return (data.deals || [])
    // Re-verify group and status client-side: AC silently IGNORES a filter it
    // doesn't recognise, so a server-side-only filter can return everything.
    .filter(d => String(d.group) === AC_GROUP && Number(d.status) === DEAL_STATUS_OPEN)
    .map(d => ({
      id: String(d.id),
      title: String(d.title || ''),
      value: (Number(d.value) || 0) / 100,
      cdate: String(d.cdate || ''),
    }))
}

// ── The pass ─────────────────────────────────────────────────────────────

export interface MyobWonMatch {
  invoiceNumber: string
  invoiceDate: string
  invoiceTotal: number
  customerName: string
  customerEmail: string
  acContactId: number
  dealId: string
  dealTitle: string
  dealValue: number
  ratio: number | null
  chosenBy: 'only_open_deal' | 'value_band' | 'most_recent'
  contactFieldsFilled: string[]
}

export interface MyobWonReport {
  live: boolean
  lookbackDays: number
  invoicesScanned: number
  invoicesWithCustomerUid: number
  invoicesWithCardEmail: number
  contactsMatched: number
  contactsNotFound: number
  noOpenDeal: number
  matched: MyobWonMatch[]
  moved: number
  contactsUpdated: number
  errors: string[]
}

export async function runMyobWonPass(live: boolean): Promise<MyobWonReport> {
  const report: MyobWonReport = {
    live,
    lookbackDays: MYOB_WON_LOOKBACK_DAYS,
    invoicesScanned: 0,
    invoicesWithCustomerUid: 0,
    invoicesWithCardEmail: 0,
    contactsMatched: 0,
    contactsNotFound: 0,
    noOpenDeal: 0,
    matched: [],
    moved: 0,
    contactsUpdated: 0,
    errors: [],
  }

  const since = new Date(Date.now() - MYOB_WON_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .substring(0, 10)

  // VPS is the workshop entity — the one Mechanics Desk invoices into.
  const invoices = await fetchSaleInvoices('VPS', { start: since })
  report.invoicesScanned = invoices.length
  if (invoices.length === 0) return report

  const { getConnection } = await import('./myob')
  const conn = await getConnection('VPS')
  if (!conn) throw new Error('No MYOB VPS connection')
  if (!conn.company_file_id) throw new Error('MYOB VPS connection has no company_file_id')
  const cards = await fetchCustomerCards(conn.company_file_id, conn.id)

  // One invoice per customer is enough: several invoices for the same
  // customer in the window would otherwise try to close the same deal
  // repeatedly. Keep the largest, which is most likely to be the quoted job.
  const bestByCustomer = new Map<string, typeof invoices[number]>()
  for (const inv of invoices) {
    if (!inv.CustomerUID) continue
    report.invoicesWithCustomerUid++
    const prev = bestByCustomer.get(inv.CustomerUID)
    if (!prev || inv.TotalAmount > prev.TotalAmount) bestByCustomer.set(inv.CustomerUID, inv)
  }

  const entries = Array.from(bestByCustomer.entries())
  for (const pair of entries) {
    const uid = pair[0]
    const inv = pair[1]
    try {
      const card = cards.get(uid)
      if (!card || !card.email) continue
      report.invoicesWithCardEmail++

      const contact = await findByEmail(card.email)
      if (!contact) { report.contactsNotFound++; continue }
      report.contactsMatched++

      const deals = await openDealsForContact(contact.id)
      if (deals.length === 0) { report.noOpenDeal++; continue }

      let chosen: ACOpenDeal
      let chosenBy: MyobWonMatch['chosenBy']
      if (deals.length === 1) {
        chosen = deals[0]
        chosenBy = 'only_open_deal'
      } else {
        const inBand = deals.filter(d => {
          if (!d.value) return false
          const r = inv.TotalAmount / d.value
          return r >= MYOB_WON_MIN_RATIO && r <= MYOB_WON_MAX_RATIO
        })
        if (inBand.length > 0) { chosen = inBand[0]; chosenBy = 'value_band' }
        else { chosen = deals[0]; chosenBy = 'most_recent' }
      }

      const ratio = chosen.value ? Math.round((inv.TotalAmount / chosen.value) * 1000) / 1000 : null

      // Fill only what AC is missing. Never overwrite — a workshop card is
      // often staler than the marketing record.
      const fills: Record<string, string> = {}
      if (!contact.phone && card.phone) fills.phone = card.phone
      if (!contact.firstName && !contact.lastName && card.name) {
        const parts = card.name.split(/\s+/)
        fills.firstName = parts[0]
        if (parts.length > 1) fills.lastName = parts.slice(1).join(' ')
      }

      const match: MyobWonMatch = {
        invoiceNumber: String(inv.Number || inv.ID),
        invoiceDate: String(inv.Date || '').substring(0, 10),
        invoiceTotal: inv.TotalAmount,
        customerName: card.name,
        customerEmail: card.email,
        acContactId: contact.id,
        dealId: chosen.id,
        dealTitle: chosen.title,
        dealValue: chosen.value,
        ratio,
        chosenBy,
        contactFieldsFilled: Object.keys(fills),
      }
      report.matched.push(match)

      if (!live) continue

      const note = [
        'Quote Won — set automatically when the invoice reached MYOB.',
        `MYOB invoice ${match.invoiceNumber} (${match.invoiceDate}, $${inv.TotalAmount.toFixed(2)}) for ${card.name}.`,
        `Matched to this contact by email (${card.email}).`,
        deals.length > 1
          ? `This contact had ${deals.length} open deals; chose this one by ${chosenBy}${ratio ? ` (invoice/deal ratio ${ratio})` : ''}.`
          : 'This was the contact\'s only open deal.',
      ].join('\n')

      await acJson(`/deals/${chosen.id}`, {
        method: 'PUT',
        body: JSON.stringify({ deal: { stage: STAGE_QUOTE_WON, status: DEAL_STATUS_WON } }),
      })
      report.moved++

      try {
        await acJson(`/notes`, {
          method: 'POST',
          body: JSON.stringify({ note: { note, relid: Number(chosen.id), reltype: 'Deal' } }),
        })
      } catch (e: any) {
        console.warn(`[myob-won] note failed on deal ${chosen.id}:`, e?.message)
      }

      if (Object.keys(fills).length > 0) {
        try {
          await acJson(`/contacts/${contact.id}`, {
            method: 'PUT',
            body: JSON.stringify({ contact: fills }),
          })
          report.contactsUpdated++
        } catch (e: any) {
          // Enrichment is a bonus; the deal move is the deliverable.
          console.warn(`[myob-won] contact ${contact.id} update failed:`, e?.message)
        }
      }
    } catch (e: any) {
      report.errors.push(`invoice ${inv.Number || inv.ID}: ${e?.message || String(e)}`)
    }
  }

  return report
}

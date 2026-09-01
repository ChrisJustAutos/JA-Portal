// lib/ap-cross-company.ts
//
// Has this supplier invoice ALREADY been entered against the OTHER company?
//
// WHY THIS EXISTS (Chris, 2026-09-02). A JMACX invoice was entered and paid in
// JAWS, where it was sitting at the ORDER stage. JMACX then sent a second copy
// to the Just Autos accounts inbox, billed to Just Autos rather than Just Autos
// Wholesale. It was entered and paid in VPS too. One supply, paid twice, across
// two company files.
//
// The mistake was JMACX's — wrong entity, wrong inbox — but nothing on our side
// could have caught it, because every duplicate check we had was blind to it in
// two separate ways:
//
//   1. IT ONLY LOOKED AT BILLS. findExistingMyobBill searches
//      Purchase/Bill/Service and Purchase/Bill/Item. The JAWS copy was a
//      purchase ORDER, so it did not exist as far as that check was concerned.
//   2. IT ONLY LOOKED AT ONE COMPANY FILE — whichever we were posting into. A
//      JAWS document is invisible while posting to VPS, and the reverse.
//
// So this searches the other direction: BOTH company files, and orders and
// quotes as well as bills.
//
// MATCHING ON NAME, NOT UID. A supplier's UID is per company file — JMACX in
// JAWS and JMACX in VPS are different UIDs entirely — so a UID comparison finds
// nothing across files by construction. Names are normalised (case, spacing,
// punctuation, and the usual Pty/Ltd noise) and matched on containment either
// way, so "JMACX" matches "JMACX Pty Ltd".
//
// TWO NETS, deliberately different in confidence:
//   • the same supplier invoice number  → near certain, reported as certain
//   • the same amount, same supplier, within a date window → suspicious, and
//     reported as suspicious. Suppliers do bill identical amounts legitimately
//     (a monthly retainer), so this one exists to be looked at, not obeyed.
//
// THE AMOUNT NET IS DELIBERATELY NARROWER THAN THE NUMBER NET, because a check
// that cries wolf gets ignored and then it protects nothing. A recurring charge
// — the same supplier, the same figure, every month — would trip a naive
// amount match forever. So it only applies to amounts of AMOUNT_NET_MIN or
// more, and only within AMOUNT_NET_DAYS of the invoice date. A small monthly
// subscription never trips it; a $48k invoice paid twice in a fortnight does.
//
// FAILS OPEN. If MYOB is unreachable the AP run continues exactly as before —
// a duplicate check that blocks the whole pipeline when it cannot answer is
// worse than the gap it closes. The caller is told the check could not run.

import { getConnection, myobFetch } from './myob'

export type CompanyFileLabel = 'JAWS' | 'VPS'

const ENTITIES: CompanyFileLabel[] = ['JAWS', 'VPS']
// Bill AND Order AND Quote: the JMACX copy sat at the order stage, which is
// precisely what the old bill-only check could not see.
const DOC_TYPES = ['Bill', 'Order', 'Quote'] as const
// The two layouts these files actually use. A file without one just 400/404s
// and is skipped.
const LAYOUTS = ['Service', 'Item'] as const

// Matching on amount alone is a weak signal, so it is bounded on both axes.
const AMOUNT_NET_MIN = 1000      // below this a coincidence is likelier than a double-up
const AMOUNT_NET_DAYS = 14       // two copies of one invoice arrive close together

export interface CrossCompanyHit {
  entity: CompanyFileLabel
  docType: string              // Bill | Order | Quote
  uid: string
  number: string | null
  supplierInvoiceNumber: string | null
  supplierName: string | null
  date: string | null
  totalAmount: number | null
  status: string | null
  /** How sure we are. 'number' is near certain; 'amount' wants a human. */
  matchedOn: 'number' | 'amount'
}

export interface CrossCompanyResult {
  hits: CrossCompanyHit[]
  /** True when at least one file could not be searched — hits may be incomplete. */
  incomplete: boolean
  notes: string[]
}

/** Strip everything that differs between two spellings of the same business. */
function normaliseSupplier(raw: string | null | undefined): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|p\/l|inc|incorporated|group|australia|aust|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim()
}

function supplierLooksSame(a: string | null | undefined, b: string | null | undefined): boolean {
  const A = normaliseSupplier(a), B = normaliseSupplier(b)
  if (!A || !B) return false
  if (A === B) return true
  // Containment either way: "jmacx" vs "jmacxptyltd" once normalised, or a
  // trading name that carries the parent's name.
  return (A.length >= 4 && B.includes(A)) || (B.length >= 4 && A.includes(B))
}

/** Same canonicalisation the in-file duplicate check uses for OCR variants. */
function sameNumberLoose(a: string | null | undefined, b: string | null | undefined): boolean {
  const canon = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/B/g, '8')
  const A = canon(String(a || '')), B = canon(String(b || ''))
  if (!A || !B) return false
  if (A === B) return true
  const dA = A.replace(/\D/g, ''), dB = B.replace(/\D/g, '')
  return dA.length >= 6 && dB.length >= 6 && (dA.endsWith(dB) || dB.endsWith(dA))
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

function withinDays(theirDate: any, ours: Date, days: number): boolean {
  const t = theirDate ? new Date(theirDate) : null
  if (!t || isNaN(+t)) return false
  return Math.abs(t.getTime() - ours.getTime()) <= days * 86400_000
}

/**
 * Look for the same supplier invoice already entered anywhere across both
 * company files, as a bill, an order or a quote.
 *
 * The file being posted into has its BILLS skipped, because findExistingMyobBill
 * already handles that case cleanly as a duplicate — this exists to fill the
 * gap, not to double up the noise. Its orders and quotes ARE searched: those
 * are new ground, and an order is what the JMACX copy was sitting at.
 */
export async function findCrossCompanyDuplicate(args: {
  postingTo: CompanyFileLabel
  supplierName: string | null
  supplierInvoiceNumber: string | null
  totalAmount: number | null
  invoiceDate: string | null
  /** Days either side of the invoice date to search. Default 45. */
  dayWindow?: number
}): Promise<CrossCompanyResult> {
  const notes: string[] = []
  const hits: CrossCompanyHit[] = []
  let incomplete = false

  const supplier = String(args.supplierName || '').trim()
  const amount = args.totalAmount != null && Number.isFinite(Number(args.totalAmount))
    ? Math.abs(Number(args.totalAmount)) : null
  const number = String(args.supplierInvoiceNumber || '').trim()

  // Without a supplier there is nothing to anchor on, and matching on amount
  // alone across two whole company files would flag half the ledger.
  if (!supplier || (!number && amount == null)) {
    return { hits, incomplete: false, notes: ['not enough to match on — skipped'] }
  }

  const base = args.invoiceDate ? new Date(args.invoiceDate) : new Date()
  if (isNaN(+base)) base.setTime(Date.now())
  const win = args.dayWindow ?? 45
  const from = new Date(base.getTime() - win * 86400_000)
  const to = new Date(base.getTime() + win * 86400_000)
  const filter = `Date ge datetime'${iso(from)}T00:00:00' and Date le datetime'${iso(to)}T23:59:59'`

  for (const entity of ENTITIES) {
    let conn: any = null
    try { conn = await getConnection(entity) } catch { /* handled below */ }
    if (!conn || !conn.company_file_id) {
      incomplete = true
      notes.push(`${entity}: no active MYOB connection — not searched`)
      continue
    }

    for (const docType of DOC_TYPES) {
      // The same file's BILLS are already covered by findExistingMyobBill; only
      // its orders and quotes are new ground.
      if (entity === args.postingTo && docType === 'Bill') continue

      for (const layout of LAYOUTS) {
        const path = `/accountright/${conn.company_file_id}/Purchase/${docType}/${layout}`
        let r: any
        try {
          r = await myobFetch(conn.id, path, { query: { '$filter': filter, '$top': 400 } })
        } catch (e: any) {
          incomplete = true
          notes.push(`${entity} ${docType}/${layout}: ${String(e?.message || e).slice(0, 80)}`)
          continue
        }
        // A file with that document type disabled just 404s — not a failure.
        if (r.status === 404 || r.status === 400) continue
        if (r.status !== 200) {
          incomplete = true
          notes.push(`${entity} ${docType}/${layout}: HTTP ${r.status}`)
          continue
        }

        for (const d of (Array.isArray(r.data?.Items) ? r.data.Items : [])) {
          if (!supplierLooksSame(d?.Supplier?.Name, supplier)) continue
          const theirNumber = d?.SupplierInvoiceNumber ?? null
          const theirTotal = typeof d?.TotalAmount === 'number' ? Math.abs(d.TotalAmount) : null

          let matchedOn: 'number' | 'amount' | null = null
          if (number && sameNumberLoose(theirNumber, number)) {
            matchedOn = 'number'
          } else if (
            amount != null && amount >= AMOUNT_NET_MIN &&
            theirTotal != null && Math.abs(theirTotal - amount) < 0.005 &&
            withinDays(d.Date, base, AMOUNT_NET_DAYS)
          ) {
            matchedOn = 'amount'
          }
          if (!matchedOn) continue

          hits.push({
            entity, docType, uid: String(d.UID || ''),
            number: d.Number ?? null,
            supplierInvoiceNumber: theirNumber,
            supplierName: d?.Supplier?.Name ?? null,
            date: d.Date ?? null,
            totalAmount: theirTotal,
            status: d.Status ?? null,
            matchedOn,
          })
        }
      }
    }
  }

  // Strongest first, and one line per document.
  hits.sort((a, b) => (a.matchedOn === b.matchedOn ? 0 : a.matchedOn === 'number' ? -1 : 1))
  const seen = new Set<string>()
  const unique = hits.filter(h => (seen.has(h.uid) ? false : (seen.add(h.uid), true)))

  return { hits: unique, incomplete, notes }
}

/** One-line summary for a Slack card / flag reason. */
export function describeCrossCompanyHit(h: CrossCompanyHit): string {
  const what = `${h.entity} ${h.docType.toLowerCase()} ${h.number || h.uid.slice(0, 8)}`
  const amt = h.totalAmount != null ? ` $${h.totalAmount.toFixed(2)}` : ''
  const when = h.date ? ` ${String(h.date).slice(0, 10)}` : ''
  const how = h.matchedOn === 'number' ? `same invoice number ${h.supplierInvoiceNumber}` : 'same amount'
  const st = h.status ? ` (${h.status})` : ''
  return `${what}${amt}${when}${st} — ${how}`
}

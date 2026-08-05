// lib/accounting/read-docs.ts
//
// READ-side seam for the MYOB → Xero migration. Thin wrappers around exactly
// the read operations the three READ modules need:
//
//   • LETTERS   (lib/workshop-letter-watch.ts, entity VPS)
//       - list recent Sale Invoices (+ per-invoice lines) since a date
//       - fetch the customer card (name + postal address) for a letter
//   • BANK      (pages/api/cron/bank-payments-slack.ts via lib/myob-bank.ts)
//       - list Spend/Receive bank transactions modified since an instant
//   • INVENTORY (lib/b2b-catalogue-sync.ts + lib/b2b-stock.ts, entity JAWS)
//       - list all inventory items (paged)
//
// Each wrapper consults accountingProvider(entity, module) — THE SWITCH:
//   'myob' → delegates to the exact logic the modules ran before this seam
//            existed (same endpoints, filters, paging, error semantics), so
//            MYOB behaviour is IDENTICAL.
//   'xero' → XeroAdapter.listInvoices / raw xeroFetch /BankTransactions /
//            XeroAdapter.listItems, mapped into the same neutral shapes.
//
// Field-mapping gaps (Xero side) — documented inline, NEVER fabricated:
//   • Invoice-line account codes: the letters deposit-vs-job rule keys off
//     MYOB account DisplayIDs ('4-xxxx' income, '1-1230' Customer Deposits).
//     Xero lines carry Xero account codes — translated back to MYOB
//     DisplayIDs via a REVERSE lookup of xero_account_map (migration 183).
//     Unmapped codes come back as accountDisplayId: null, which makes the
//     invoice fail the income test and get SKIPPED (never a wrong print).
//   • Xero's listInvoices rows carry no ContactID → customerUid is null and
//     the letter customer card is resolved by exact contact name instead.
//   • Xero bank txns: MYOB cheque Number ≈ Xero Reference; memo = first
//     line-item description; bankAccountDisplayId reverse-mapped via
//     xero_account_map (null when unmapped).
//   • Xero items: no QuantityAvailable (committed-qty) concept → null, the
//     b2b-stock fallback to on-hand applies; no SalesDetails.TaxCode on the
//     adapter row → TaxCode null (is_taxable reads false — see GAP note);
//     no supplier/restock link → BuyingDetails null.
//
// NOTE: the Xero branch imports XeroAdapter DIRECTLY (not through
// getAccountingAdapter) because lib/accounting/types.ts and the adapter's
// local neutral types haven't been reconciled yet — using the adapter's own
// concrete types keeps this file honest about the shapes actually returned
// at runtime. Once the seam agent reconciles the adapter to ./types, switch
// to the factory.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from '../myob'
import { xeroFetch } from '../xero'
import { XeroAdapter, parseXeroDate } from './xero-adapter'
import { accountingProvider, type AccountingEntity } from '../accounting-provider'
import {
  fetchBankTxnsSince as myobFetchBankTxnsSince,
  type BankTxn,
  type CompanyTxnsResult,
} from '../myob-bank'

export type { BankTxn, CompanyTxnsResult }

// ── Shared helpers ──────────────────────────────────────────────────────

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

/**
 * REVERSE lookup of xero_account_map (migration 183): Xero account code →
 * MYOB account DisplayID, per entity. The map is seeded MYOB→Xero for
 * posting; reads invert it so MYOB-era rules (letters '4-'/'1-1230',
 * bank DisplayIDs) keep working against Xero data.
 *
 * If two MYOB accounts were mapped onto ONE Xero code the reverse is
 * ambiguous — first row wins (ordered by myob_display_id for determinism).
 */
async function reverseAccountMap(entity: AccountingEntity): Promise<Map<string, string>> {
  const { data, error } = await sb()
    .from('xero_account_map')
    .select('myob_display_id, xero_account_code')
    .eq('entity', entity)
    .order('myob_display_id', { ascending: true })
  if (error) throw new Error(`xero_account_map lookup failed: ${error.message}`)
  const out = new Map<string, string>()
  for (const row of data || []) {
    const code = String(row.xero_account_code || '').trim()
    if (!code || out.has(code)) continue // first wins on reverse collisions
    out.set(code, String(row.myob_display_id || ''))
  }
  return out
}

/** Parse Xero "/Date(1518685950940+0000)/" (or ISO) → full ISO timestamp
 *  ('' if unparseable). parseXeroDate (adapter) is date-only; the bank
 *  digest sorts on lastModified so we keep the time component here. */
function parseXeroDateTime(v: any): string {
  if (!v) return ''
  const s = String(v)
  const m = s.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//)
  const d = m ? new Date(Number(m[1])) : new Date(s)
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

// ════════════════════════════════════════════════════════════════════════
// LETTERS — recent sale invoices with lines + customer card
// ════════════════════════════════════════════════════════════════════════

export interface SaleInvoiceListRow {
  /** Provider-native document id (MYOB UID / Xero InvoiceID). */
  uid: string
  number: string
  customerName: string
  /** Provider-native customer id. GAP: null on Xero — the adapter's
   *  listInvoices rows carry no ContactID; the card is then looked up by
   *  exact contact name. */
  customerUid: string | null
  /** GST-inclusive invoice total. */
  totalAmount: number
  /** MYOB invoice layout ('Item'/'Service'/…) needed for the MYOB detail
   *  fetch; null on Xero. */
  invoiceType: string | null
}

export interface SaleInvoiceLineRow {
  /** MYOB: raw line Type ('Transaction'/'Header'/'Subtotal'). Xero has no
   *  header/subtotal lines — every line is a transaction line, so the Xero
   *  branch reports 'Transaction' (translation, not fabrication). */
  type: string
  /** MYOB account DisplayID ('4-1100', '1-1230'). On Xero this is the
   *  REVERSE xero_account_map translation of the line's Xero account code —
   *  null when the code has no mapping (invoice then fails the income test
   *  and is skipped rather than wrongly printed). */
  accountDisplayId: string | null
  /** Line total, sign as the provider reports it (deposit-applied lines
   *  are negative). */
  total: number
}

export interface CustomerCardRow {
  name: string
  /** Postal address as printable lines (street lines then "City State Post"). */
  addressLines: string[]
}

export interface SaleInvoiceReader {
  provider: 'myob' | 'xero'
  invoices: SaleInvoiceListRow[]
  /** Per-invoice line detail. MYOB: detail fetch (as before). Xero: lines
   *  were pulled with the list (withLines) and are returned from memory. */
  fetchLines(inv: SaleInvoiceListRow): Promise<SaleInvoiceLineRow[]>
  /** Customer card for the letter. Returns null when the card can't be
   *  fetched — caller falls back to the invoice name with no address. */
  fetchCustomerCard(customerUid: string | null, fallbackName: string): Promise<CustomerCardRow | null>
}

// — MYOB card mapping (moved verbatim from lib/workshop-letter-watch.ts) —

function myobCustomerNameFrom(card: any, fallback: string): string {
  if (!card) return fallback
  if (card.CompanyName) return String(card.CompanyName)
  const n = [card.FirstName, card.LastName].filter(Boolean).join(' ').trim()
  return n || fallback
}

function myobAddressLinesFrom(card: any): string[] {
  const addrs = Array.isArray(card?.Addresses) ? card.Addresses : []
  const a = addrs.find((x: any) => x?.Location === 1) || addrs[0]
  if (!a) return []
  const lines: string[] = []
  if (a.Street) String(a.Street).split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean).forEach((s: string) => lines.push(s))
  const cityLine = [a.City, a.State, a.PostCode].filter(Boolean).join(' ').trim()
  if (cityLine) lines.push(cityLine)
  return lines
}

async function openMyobSaleInvoiceReader(entity: AccountingEntity, sinceDateIso: string): Promise<SaleInvoiceReader> {
  const conn = await getConnection(entity)
  if (!conn || !conn.company_file_id) throw new Error(`${entity} MYOB connection not configured`)
  const base = `/accountright/${conn.company_file_id}/Sale/Invoice`

  const list = await myobFetch(conn.id, base, {
    query: { '$filter': `Date ge datetime'${sinceDateIso}'`, '$orderby': 'Date desc', '$top': 200 },
  })
  if (list.status !== 200) throw new Error(`MYOB invoice list failed (HTTP ${list.status})`)
  const items: any[] = Array.isArray(list.data?.Items) ? list.data.Items : []

  const invoices: SaleInvoiceListRow[] = items
    .filter(i => i && i.UID)
    .map(i => ({
      uid: String(i.UID),
      number: String(i.Number ?? ''),
      customerName: i.Customer?.Name || '',
      customerUid: i.Customer?.UID || null,
      totalAmount: Number(i.TotalAmount) || 0,
      invoiceType: i.InvoiceType || null,
    }))

  return {
    provider: 'myob',
    invoices,
    async fetchLines(inv) {
      const d = await myobFetch(conn.id, `${base}/${inv.invoiceType || 'Item'}/${inv.uid}`)
      const raw: any[] = Array.isArray(d.data?.Lines) ? d.data.Lines : []
      return raw.map(l => ({
        type: String(l?.Type || ''),
        accountDisplayId: l?.Account?.DisplayID != null ? String(l.Account.DisplayID) : null,
        total: Number(l?.Total) || 0,
      }))
    },
    async fetchCustomerCard(customerUid, fallbackName) {
      if (!customerUid) return null
      const c = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Contact/Customer/${customerUid}`)
      if (c.status !== 200) return null
      return {
        name: myobCustomerNameFrom(c.data, fallbackName),
        addressLines: myobAddressLinesFrom(c.data),
      }
    },
  }
}

/** Escape + quote for a Xero where-clause string literal. */
function xq(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function xeroCardFromContact(contact: any, fallbackName: string): CustomerCardRow {
  const name = String(
    contact?.Name
    || [contact?.FirstName, contact?.LastName].filter(Boolean).join(' ').trim()
    || fallbackName,
  )
  // Xero convention: POBOX is the postal/mailing address; STREET is physical.
  // Prefer a POBOX address with content, else fall back to STREET.
  const addrs: any[] = Array.isArray(contact?.Addresses) ? contact.Addresses : []
  const hasContent = (a: any) => !!(a && (a.AddressLine1 || a.City || a.PostalCode))
  const a = addrs.find(x => x?.AddressType === 'POBOX' && hasContent(x))
    || addrs.find(x => x?.AddressType === 'STREET' && hasContent(x))
    || null
  const lines: string[] = []
  if (a) {
    for (const k of ['AddressLine1', 'AddressLine2', 'AddressLine3', 'AddressLine4']) {
      const v = String(a[k] || '').trim()
      if (v) lines.push(v)
    }
    const cityLine = [a.City, a.Region, a.PostalCode].filter(Boolean).join(' ').trim()
    if (cityLine) lines.push(cityLine)
  }
  return { name, addressLines: lines }
}

async function openXeroSaleInvoiceReader(entity: AccountingEntity, sinceDateIso: string): Promise<SaleInvoiceReader> {
  const adapter = new XeroAdapter(entity)
  const revMap = await reverseAccountMap(entity)

  // Upper bound: the adapter's listInvoices requires a dateToIso and its
  // where clause is Date<= (inclusive). Use tomorrow (UTC) so no TZ edge
  // can drop a today-dated invoice.
  const dateToIso = new Date(Date.now() + 86400_000).toISOString().slice(0, 10)
  const rows = await adapter.listInvoices({
    kind: 'sale',
    dateFromIso: sinceDateIso,
    dateToIso,
    withLines: true,
  })

  // Parity with MYOB: MYOB's Sale/Invoice list never contains deleted
  // invoices; drop Xero VOIDED ones (the adapter already excludes DELETED).
  const live = rows.filter(r => String(r.status).toUpperCase() !== 'VOIDED')

  const linesByUid = new Map<string, SaleInvoiceLineRow[]>()
  const invoices: SaleInvoiceListRow[] = live.map(r => {
    linesByUid.set(r.id, (r.lines || []).map(l => ({
      // Xero has no header/subtotal lines — every returned line is a
      // transaction line.
      type: 'Transaction',
      // REVERSE xero_account_map translation; null when unmapped (the
      // invoice then fails the income test and is skipped — documented gap,
      // never fabricated).
      accountDisplayId: l.accountCode != null ? (revMap.get(String(l.accountCode)) ?? null) : null,
      total: Number(l.amount) || 0,
    })))
    return {
      uid: r.id,
      number: r.number,
      customerName: r.contactName,
      // GAP: XeroAdapter.listInvoices rows carry no ContactID — the letter
      // card lookup falls back to exact contact name (see fetchCustomerCard).
      customerUid: null,
      totalAmount: Number(r.total) || 0,
      invoiceType: null,
    }
  })

  return {
    provider: 'xero',
    invoices,
    async fetchLines(inv) {
      return linesByUid.get(inv.uid) || []
    },
    async fetchCustomerCard(customerUid, fallbackName) {
      let contact: any = null
      if (customerUid) {
        try {
          const j = await xeroFetch(entity, `/Contacts/${encodeURIComponent(customerUid)}`)
          contact = j?.Contacts?.[0] || null
        } catch {
          return null
        }
      } else if (fallbackName && fallbackName.trim()) {
        const name = fallbackName.trim()
        const j = await xeroFetch(entity,
          `/Contacts?where=${encodeURIComponent(`Name.ToLower()==${xq(name.toLowerCase())}`)}`)
        contact = j?.Contacts?.[0] || null
      }
      if (!contact) return null
      return xeroCardFromContact(contact, fallbackName)
    },
  }
}

/**
 * LETTERS entry point: list sale invoices dated on/after sinceDateIso
 * ('YYYY-MM-DD') plus lazy line/card fetchers. MYOB path is byte-for-byte
 * the logic workshop-letter-watch ran before this seam.
 */
export async function openSaleInvoiceReader(
  entity: AccountingEntity,
  module: string,
  sinceDateIso: string,
): Promise<SaleInvoiceReader> {
  const provider = await accountingProvider(entity, module)
  return provider === 'xero'
    ? openXeroSaleInvoiceReader(entity, sinceDateIso)
    : openMyobSaleInvoiceReader(entity, sinceDateIso)
}

// ════════════════════════════════════════════════════════════════════════
// BANK — Spend/Receive money transactions for the daily digest
// ════════════════════════════════════════════════════════════════════════

async function fetchXeroBankTxns(entity: AccountingEntity, since: Date): Promise<BankTxn[]> {
  const revMap = await reverseAccountMap(entity)
  const out: BankTxn[] = []

  // Xero: If-Modified-Since filters by UpdatedDateUTC server-side — the
  // closest analogue of the MYOB LastModified OData filter (catches newly
  // entered AND re-allocated txns). Paged (100/page); the page param also
  // makes Xero include LineItems, which we use for the memo.
  const headers = { 'If-Modified-Since': since.toUTCString() }
  for (let page = 1; page <= 50; page++) {
    const j = await xeroFetch(entity, `/BankTransactions?page=${page}&order=${encodeURIComponent('Date')}`, { headers })
    const batch: any[] = j?.BankTransactions || []
    for (const t of batch) {
      if (String(t?.Status || '').toUpperCase() === 'DELETED') continue
      // SPEND / SPEND-OVERPAYMENT / SPEND-PREPAYMENT → 'spend';
      // RECEIVE / RECEIVE-* → 'receive'. Anything else (none documented)
      // is skipped rather than guessed.
      const type = String(t?.Type || '').toUpperCase()
      const kind: BankTxn['kind'] | null =
        type.startsWith('SPEND') ? 'spend' : type.startsWith('RECEIVE') ? 'receive' : null
      if (!kind) continue

      const bankCode = t?.BankAccount?.Code ? String(t.BankAccount.Code) : null
      const memoLine = Array.isArray(t?.LineItems)
        ? String(t.LineItems.find((l: any) => l?.Description)?.Description || '').trim()
        : ''
      out.push({
        uid: String(t.BankTransactionID),
        kind,
        date: parseXeroDate(t.Date),
        lastModified: parseXeroDateTime(t.UpdatedDateUTC) || parseXeroDate(t.Date),
        // GAP: MYOB's cheque/txn Number has no Xero equivalent — Reference
        // is the closest field; null when blank.
        number: t.Reference ? String(t.Reference) : null,
        amount: Math.abs(Number(t.Total) || 0),
        payeeOrPayer: t?.Contact?.Name ? String(t.Contact.Name) : null,
        // GAP: Xero bank txns have no top-level Memo — first line-item
        // description is the narration shown in the Xero UI; null when none.
        memo: memoLine || null,
        bankAccountName: t?.BankAccount?.Name ? String(t.BankAccount.Name) : null,
        // REVERSE xero_account_map translation back to the MYOB DisplayID;
        // null when the bank account's Xero code isn't mapped (documented
        // gap — the digest displays bankAccountName, not this).
        bankAccountDisplayId: bankCode ? (revMap.get(bankCode) ?? null) : null,
      })
    }
    if (batch.length < 100) break
  }

  // Same newest-first ordering as lib/myob-bank.ts.
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.lastModified < b.lastModified ? 1 : -1
  })
  return out
}

/**
 * BANK entry point: Spend + Receive money transactions modified since the
 * given instant, same CompanyTxnsResult contract as lib/myob-bank.ts
 * (never throws — errors come back on the result). MYOB path delegates to
 * fetchBankTxnsSince unchanged.
 */
export async function fetchBankTransactionsSince(
  entity: AccountingEntity,
  since: Date,
  module: string = 'BANK',
): Promise<CompanyTxnsResult> {
  const provider = await accountingProvider(entity, module)
  if (provider !== 'xero') return myobFetchBankTxnsSince(entity, since)

  try {
    const txns = await fetchXeroBankTxns(entity, since)
    return { label: entity, connected: true, txns }
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 300)
    const notConnected = /not connected|no organisation assigned/i.test(msg)
    return { label: entity, connected: !notConnected, txns: [], error: msg }
  }
}

// ════════════════════════════════════════════════════════════════════════
// INVENTORY — full item listing (catalogue sync + stock cache)
// ════════════════════════════════════════════════════════════════════════

/**
 * Neutral inventory item in the MYOB Inventory/Item field convention both
 * consumers already speak. On MYOB these are the RAW item objects (the
 * index signature carries every other MYOB field, so myob_snapshot keeps
 * its full fidelity); on Xero the adapter's ItemRow is mapped in.
 */
export interface AccountingInventoryItem {
  UID: string
  Number: string
  Name: string
  Description?: string | null
  IsActive?: boolean
  IsSold?: boolean
  IsInventoried?: boolean
  QuantityAvailable?: number | null
  QuantityOnHand?: number | null
  SellingDetails?: {
    BaseSellingPrice?: number
    IsTaxInclusive?: boolean
    TaxCode?: { UID?: string; Code?: string } | null
  } | null
  BuyingDetails?: {
    RestockingInformation?: {
      Supplier?: { UID?: string; Name?: string } | null
      SupplierItemNumber?: string | null
    } | null
  } | null
  [k: string]: any
}

const MYOB_ITEM_PAGE_SIZE = 400 // MYOB AccountRight caps $top at 400

async function listMyobInventoryItems(
  entity: AccountingEntity,
  performedBy: string | null,
): Promise<AccountingInventoryItem[]> {
  const conn = await getConnection(entity)
  if (!conn || !conn.is_active) {
    throw new Error(`No active ${entity} MYOB connection. Connect via Settings → MYOB.`)
  }
  if (!conn.company_file_id) {
    throw new Error(`${entity} MYOB connection has no company file selected.`)
  }

  // Full unfiltered pull, paged by $skip — MYOB Item OData filters are
  // fragile across tenants, so consumers filter in JS (as they always have).
  // Cap at 50 pages (20k items at 400/page) as a sanity bound.
  const allItems: AccountingInventoryItem[] = []
  let skip = 0
  for (let page = 0; page < 50; page++) {
    const { status, data, raw } = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Inventory/Item`, {
      method: 'GET',
      query: { '$top': MYOB_ITEM_PAGE_SIZE, '$skip': skip },
      performedBy,
    })
    if (status !== 200) {
      const myobMsg = data?.Errors?.[0]?.Message
        || data?.Message
        || (raw || '').substring(0, 400)
      throw new Error(`MYOB Inventory/Item fetch failed (skip=${skip}, HTTP ${status}): ${myobMsg}`)
    }
    const items: any[] = Array.isArray(data?.Items) ? data.Items : []
    allItems.push(...items)
    if (items.length < MYOB_ITEM_PAGE_SIZE) break
    skip += MYOB_ITEM_PAGE_SIZE
  }
  return allItems
}

async function listXeroInventoryItems(entity: AccountingEntity): Promise<AccountingInventoryItem[]> {
  const adapter = new XeroAdapter(entity)
  const items = await adapter.listItems()
  return items.map((it): AccountingInventoryItem => ({
    UID: it.id,
    Number: it.code,
    Name: it.name,
    Description: it.description ?? null,
    // Xero has no active/archived state on items — everything /Items
    // returns is live.
    IsActive: true,
    // Xero marks sellability by the presence of SalesDetails; the adapter
    // surfaces that as salesUnitPrice/salesAccountCode.
    IsSold: it.salesUnitPrice != null || it.salesAccountCode != null,
    IsInventoried: !!it.isTracked,
    // GAP: Xero /Items exposes only QuantityOnHand — there is no
    // QuantityAvailable (on-hand minus committed) concept. Left null so
    // b2b-stock's existing `QuantityAvailable ?? QuantityOnHand` fallback
    // takes over; NOT copied from on-hand to avoid claiming a committed-
    // aware number we don't have.
    QuantityAvailable: null,
    QuantityOnHand: it.quantityOnHand ?? null,
    SellingDetails: {
      // Xero item sell prices are stored tax-EXCLUSIVE.
      BaseSellingPrice: it.salesUnitPrice ?? 0,
      IsTaxInclusive: false,
      // GAP: the Xero adapter's ItemRow does not expose SalesDetails.TaxType,
      // so we cannot tell GST vs GST-free here. TaxCode is null — which the
      // catalogue sync reads as is_taxable=false. Fix by exposing TaxType on
      // XeroAdapter.toItemRow and mapping OUTPUT→GST / EXEMPTOUTPUT→FRE.
      TaxCode: null,
    },
    // GAP: Xero items carry no reorder/primary-supplier link (MYOB
    // BuyingDetails.RestockingInformation) — supplier fields stay null on
    // the catalogue row.
    BuyingDetails: null,
  }))
}

/**
 * INVENTORY entry point: every inventory item, paged. MYOB path is the
 * exact paging loop b2b-catalogue-sync / b2b-stock ran before this seam.
 */
export async function listInventoryItems(
  entity: AccountingEntity,
  module: string = 'INVENTORY',
  opts: { performedBy?: string | null } = {},
): Promise<AccountingInventoryItem[]> {
  const provider = await accountingProvider(entity, module)
  return provider === 'xero'
    ? listXeroInventoryItems(entity)
    : listMyobInventoryItems(entity, opts.performedBy ?? null)
}

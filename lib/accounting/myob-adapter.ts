// lib/accounting/myob-adapter.ts
//
// AccountingAdapter implementation for MYOB AccountRight. Wraps the battle-
// tested MYOB business libs where they expose reusable pieces:
//
//   - contacts / tax codes .... lib/ap-myob-lookup.ts (suppliers) + direct
//                               Contact/Customer calls mirroring
//                               lib/stripe-myob-sync.ts conventions
//   - supplier bills .......... lib/ap-myob-bill.ts (buildServiceBillBody —
//                               the strict cent-reconciliation builder — plus
//                               ensureTaxCodes + findExistingMyobBill adopt)
//   - bill payments ........... lib/ap-payment.ts (applyBillPayment)
//   - sale listings ........... lib/myob-reporting.ts (NextPageLink paging)
//
// Everything else follows the conventions those libs established:
//   - UID comes back in the Location header; it contains TWO UUIDs
//     (cfId + doc UID) — take the LAST and refuse to return the cfId.
//   - Page with NextPageLink, never bare $top/$skip (rows shift between
//     pages without it — see lib/myob-reporting.ts).
//   - Item updates are GET-modify-PUT so RowVersion survives (see
//     lib/workshop-myob-items.ts).
//   - MYOB has no 'draft' sale invoice — 'draft' maps to a Sale ORDER
//     (no GL impact), 'authorised' to a Sale Invoice, matching the
//     workshop invoice_as_order convention.
//   - Credit notes are negative invoices/bills (MYOB has no credit-note
//     entity) — matching lib/workshop-credit-note.ts.
//
// Neutral-shape translation (see lib/accounting/types.ts):
//   - line `amount` is GST-INCLUSIVE dollars. Bills post via the builder's
//     tax-INCLUSIVE path so document totals match the source to the cent.
//     Sale invoices post ex-GST Service lines (amount / 1.1), matching
//     lib/workshop-myob-invoice.ts.
//   - `accountCode` (e.g. '5-1000') resolves to the Account UID via a
//     per-instance cache.
//
// Known limitations (documented, not silent):
//   - createBill ignores dueDateIso — MYOB derives due dates from the
//     supplier card's terms; there is no per-bill override on POST.
//   - findContact by ABN alone pages the contact list and matches client-
//     side (AccountRight can't filter on the nested ABN field reliably).

import { getConnection, myobFetch, MyobConnection } from '../myob'
import {
  searchSuppliers,
  getSupplierByUid,
  createSupplier,
  getTaxCodeByCode,
  MyobSupplierLite,
} from '../ap-myob-lookup'
import { ensureTaxCodes, findExistingMyobBill, buildServiceBillBody } from '../ap-myob-bill'
import { applyBillPayment } from '../ap-payment'
import { fetchSaleInvoicesWithLines } from '../myob-reporting'
import type {
  AccountingAdapter,
  AccountingContact,
  AccountingEntity,
  AccountingItem,
  ApplyPaymentInput,
  ApplyPaymentResult,
  BillMatch,
  ContactKind,
  ContactQuery,
  CreateBillInput,
  CreateBillResult,
  CreateContactInput,
  CreateCreditNoteInput,
  CreateCreditNoteResult,
  CreateInvoiceInput,
  CreateInvoiceResult,
  DocumentKind,
  DocumentLineInput,
  InventoryAdjustmentInput,
  InventoryAdjustmentResult,
  InvoiceLineRow,
  InvoiceRow,
  ListInvoicesQuery,
  ListItemsQuery,
  PingResult,
  TaxType,
  UpdateItemPatch,
} from './types'

const GST_RATE = 0.10
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const round2 = (n: number) => Math.round(n * 100) / 100

// MYOB $filter date literal (plain date → midnight).
const dt = (d: string) => `datetime'${d.substring(0, 10)}T00:00:00'`

// Layout candidates per document kind — MYOB scopes every document URL by
// layout, but callers only hold a UID, so we probe layouts in likelihood
// order (wrong layout → 404, try the next).
const SALE_LAYOUTS = ['Item', 'Service', 'Professional', 'Miscellaneous', 'TimeBilling']
const BILL_LAYOUTS = ['Service', 'Item', 'Professional', 'Miscellaneous']

function myobErrorDetail(result: { status: number; data: any; raw: string }): string {
  const e0 = result.data?.Errors?.[0]
  return e0?.Message || e0?.AdditionalDetails || (result.raw || '').substring(0, 300) || `HTTP ${result.status}`
}

function extractUidFromLocation(headers: Record<string, string>, cfId: string): string | null {
  const location = headers?.['location'] || ''
  const uuids = String(location).match(UUID_REGEX_G) || []
  const last = uuids[uuids.length - 1] || null
  return last && last.toLowerCase() !== cfId.toLowerCase() ? last : null
}

function taxRate(taxType: TaxType | string | undefined): number {
  return String(taxType || 'GST').toUpperCase() === 'FRE' ? 0 : GST_RATE
}

export class MyobAdapter implements AccountingAdapter {
  readonly provider = 'myob' as const
  readonly entity: AccountingEntity

  private _conn: MyobConnection | null = null
  private _accountUidByCode = new Map<string, string>()

  constructor(entity: AccountingEntity) {
    this.entity = entity
  }

  // ── Plumbing ──────────────────────────────────────────────────────────

  private async conn(): Promise<MyobConnection> {
    if (this._conn) return this._conn
    const conn = await getConnection(this.entity)
    if (!conn) throw new Error(`No active MYOB connection for ${this.entity}`)
    if (!conn.company_file_id) throw new Error(`MYOB connection ${this.entity} has no company file selected`)
    this._conn = conn
    return conn
  }

  private async cfPath(): Promise<string> {
    const c = await this.conn()
    return `/accountright/${c.company_file_id}`
  }

  // NextPageLink paging — do NOT page with bare $top/$skip (no stable
  // ordering guarantee; rows get silently dropped — see lib/myob-reporting).
  private async pageAll(entityPath: string, query: Record<string, string | number> = {}): Promise<any[]> {
    const c = await this.conn()
    const out: any[] = []
    let path: string | null = `/accountright/${c.company_file_id}/${entityPath}`
    let firstQuery: Record<string, string | number> | null = { ...query, '$top': 400 }
    for (let page = 0; page < 500 && path; page++) {
      const r = await myobFetch(c.id, path, firstQuery ? { query: firstQuery } : {})
      if (r.status !== 200) throw new Error(`MYOB ${entityPath} ${this.entity}: HTTP ${r.status} ${(r.raw || '').slice(0, 160)}`)
      const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
      out.push(...items)
      const next: string | null = typeof r.data?.NextPageLink === 'string' && r.data.NextPageLink ? r.data.NextPageLink : null
      if (next) {
        // NextPageLink's host varies (arl*.api.myob.com) — keep path+query only.
        try { const u = new URL(next, 'https://api.myob.com'); path = u.pathname + u.search } catch { path = null }
      } else {
        path = null
      }
      firstQuery = null
    }
    return out
  }

  // Resolve a chart code ('5-1000') to the Account UID; cached per instance.
  private async accountUidByCode(code: string): Promise<string> {
    const key = code.trim()
    const cached = this._accountUidByCode.get(key)
    if (cached) return cached
    const c = await this.conn()
    const safe = key.replace(/'/g, "''")
    const r = await myobFetch(c.id, `/accountright/${c.company_file_id}/GeneralLedger/Account`, {
      query: { '$filter': `DisplayID eq '${safe}'`, '$top': 1 },
    })
    if (r.status !== 200) throw new Error(`MYOB account lookup failed for ${key} (HTTP ${r.status})`)
    const uid: string | undefined = r.data?.Items?.[0]?.UID
    if (!uid) throw new Error(`No MYOB ${this.entity} account with code '${key}'`)
    this._accountUidByCode.set(key, uid)
    return uid
  }

  private async taxUidFor(taxType: TaxType | undefined): Promise<string> {
    const code: TaxType = String(taxType || 'GST').toUpperCase() === 'FRE' ? 'FRE' : 'GST'
    const tc = await getTaxCodeByCode(this.entity, code)
    if (!tc) throw new Error(`MYOB ${this.entity} company file has no tax code '${code}'`)
    return tc.uid
  }

  // Find a document by UID across layout candidates. Returns the concrete
  // (layout-qualified) path plus the full entity body.
  private async findDocument(kind: DocumentKind, id: string): Promise<{ path: string; data: any }> {
    const cf = await this.cfPath()
    const c = await this.conn()
    const bases = kind === 'bill'
      ? BILL_LAYOUTS.map(l => `${cf}/Purchase/Bill/${l}`)
      : SALE_LAYOUTS.map(l => `${cf}/Sale/Invoice/${l}`)
    let lastStatus = 0
    for (const base of bases) {
      const r = await myobFetch(c.id, `${base}/${id}`)
      if (r.status === 200 && r.data?.UID) return { path: `${base}/${id}`, data: r.data }
      lastStatus = r.status
    }
    throw new Error(`MYOB ${kind} ${id} not found in ${this.entity} (last HTTP ${lastStatus})`)
  }

  // ── Contacts ──────────────────────────────────────────────────────────

  async findContact(kind: ContactKind, query: ContactQuery): Promise<AccountingContact | null> {
    if (!query.id && !query.name && !query.abn) throw new Error('findContact needs id, name or abn')

    if (kind === 'supplier') {
      if (query.id) {
        const s = await getSupplierByUid(this.entity, query.id)
        return s ? this.mapSupplier(s) : null
      }
      if (query.name) {
        const hits = await searchSuppliers(this.entity, query.name, 20)
        if (hits.length === 0) return null
        const wantAbn = (query.abn || '').replace(/\D/g, '')
        const best = wantAbn ? hits.find(h => (h.abn || '').replace(/\D/g, '') === wantAbn) || hits[0] : hits[0]
        return this.mapSupplier(best)
      }
      // ABN-only: AccountRight can't filter the nested ABN field reliably —
      // page the supplier list and match client-side.
      const wantAbn = (query.abn || '').replace(/\D/g, '')
      const all = await this.pageAll('Contact/Supplier', { '$orderby': 'CompanyName' })
      const hit = all.find(s => String(s?.BuyingDetails?.ABN || '').replace(/\D/g, '') === wantAbn)
      return hit ? this.mapRawContact(hit, 'supplier') : null
    }

    // Customers
    const c = await this.conn()
    const cf = await this.cfPath()
    if (query.id) {
      const r = await myobFetch(c.id, `${cf}/Contact/Customer/${encodeURIComponent(query.id)}`)
      if (r.status === 404) return null
      if (r.status !== 200) throw new Error(`MYOB customer fetch failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
      return this.mapRawContact(r.data, 'customer')
    }
    if (query.name) {
      // Case-insensitive multi-token search (same convention as searchSuppliers).
      const tokens = query.name.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3)
      if (tokens.length === 0) return null
      const clause = tokens.map(t => {
        const safe = t.replace(/'/g, "''")
        return `(substringof('${safe}',tolower(CompanyName)) or ` +
               `substringof('${safe}',tolower(LastName)) or ` +
               `substringof('${safe}',tolower(FirstName)))`
      }).join(' and ')
      const r = await myobFetch(c.id, `${cf}/Contact/Customer`, {
        query: { '$top': 20, '$orderby': 'CompanyName', '$filter': `IsActive eq true and ${clause}` },
      })
      if (r.status !== 200) throw new Error(`MYOB customer search failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
      const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
      if (items.length === 0) return null
      const wantAbn = (query.abn || '').replace(/\D/g, '')
      const best = wantAbn
        ? items.find(i => String(i?.SellingDetails?.ABN || '').replace(/\D/g, '') === wantAbn) || items[0]
        : items[0]
      return this.mapRawContact(best, 'customer')
    }
    const wantAbn = (query.abn || '').replace(/\D/g, '')
    const all = await this.pageAll('Contact/Customer', { '$orderby': 'CompanyName' })
    const hit = all.find(s => String(s?.SellingDetails?.ABN || '').replace(/\D/g, '') === wantAbn)
    return hit ? this.mapRawContact(hit, 'customer') : null
  }

  async createContact(kind: ContactKind, input: CreateContactInput): Promise<AccountingContact> {
    if (kind === 'supplier') {
      const created = await createSupplier(this.entity, {
        companyName: input.name,
        abn: input.abn ?? null,
        taxCode: input.taxType === 'FRE' ? 'FRE' : 'GST',
        email: input.email ?? null,
        phone: input.phone ?? null,
        street: input.address?.street ?? null,
        city: input.address?.city ?? null,
        state: input.address?.state ?? null,
        postcode: input.address?.postcode ?? null,
        country: input.address?.country ?? null,
      })
      return this.mapSupplier(created)
    }

    // Customer card — MYOB requires SellingDetails with a tax code on create
    // (same shape lib/stripe-myob-sync.ts uses).
    const c = await this.conn()
    const cf = await this.cfPath()
    const taxUid = await this.taxUidFor(input.taxType)
    const trimmed = input.name.trim()
    if (!trimmed) throw new Error('Contact name is required')
    const looksLikePerson = /^[A-Z][a-z]+(?:\s+[A-Z][a-z\-']+){1,3}$/.test(trimmed)
    const body: any = {
      IsIndividual: looksLikePerson,
      IsActive: true,
      SellingDetails: {
        SaleLayout: 'Service',
        TaxCode: { UID: taxUid },
        FreightTaxCode: { UID: taxUid },
        IsTaxInclusive: true,
      },
    }
    if (looksLikePerson) {
      const parts = trimmed.split(/\s+/)
      body.FirstName = parts.slice(0, parts.length - 1).join(' ')
      body.LastName = parts[parts.length - 1]
    } else {
      body.CompanyName = trimmed
    }
    if (input.abn) body.SellingDetails.ABN = String(input.abn).replace(/\s/g, '')
    const primary: any = { Location: 1 }
    let hasAddr = false
    if (input.email) { primary.Email = input.email; hasAddr = true }
    if (input.phone) { primary.Phone1 = input.phone; hasAddr = true }
    if (input.address?.street) { primary.Street = input.address.street; hasAddr = true }
    if (input.address?.city) { primary.City = input.address.city; hasAddr = true }
    if (input.address?.state) { primary.State = input.address.state; hasAddr = true }
    if (input.address?.postcode) { primary.PostCode = input.address.postcode; hasAddr = true }
    if (input.address?.country) { primary.Country = input.address.country; hasAddr = true }
    if (hasAddr) body.Addresses = [primary]

    const r = await myobFetch(c.id, `${cf}/Contact/Customer`, {
      method: 'POST', body, query: { returnBody: 'true' },
    })
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`MYOB customer create failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    const uid: string | null = r.data?.UID || extractUidFromLocation(r.headers, c.company_file_id!)
    if (!uid) throw new Error('MYOB created the customer but returned no UID')
    const found = await this.findContact('customer', { id: uid })
    if (!found) throw new Error('Created customer but could not re-fetch it')
    return found
  }

  // ── Supplier bills ────────────────────────────────────────────────────

  async createBill(input: CreateBillInput): Promise<CreateBillResult> {
    if (!input.lines?.length && !input.singleTotal) throw new Error('createBill needs lines or singleTotal')
    if (input.lines?.length && input.singleTotal) throw new Error('createBill takes lines OR singleTotal, not both')
    const c = await this.conn()
    const cfId = c.company_file_id!

    // Smart adopt — same reference + supplier already in MYOB means adopt,
    // not duplicate (makes retries idempotent, à la lib/ap-myob-bill).
    const existing = await findExistingMyobBill(c.id, cfId, input.reference, input.contactId, {
      expectedTotal: input.totalIncGst ?? null,
    })
    if (existing) return { id: existing.uid, reference: input.reference, adopted: true }

    // Neutral lines → builder lines. Account fallback order: per-line
    // accountCode → supplier card default expense account → error.
    const neutral: DocumentLineInput[] = input.lines?.length
      ? input.lines
      : [{
          description: input.singleTotal!.description || `Invoice ${input.reference}`,
          amount: input.singleTotal!.amount,
          accountCode: input.singleTotal!.accountCode,
          taxType: input.singleTotal!.taxType,
        }]
    let supplier: MyobSupplierLite | null = null
    const builderLines = []
    for (let i = 0; i < neutral.length; i++) {
      const l = neutral[i]
      let accountUid: string
      if (l.accountCode) {
        accountUid = await this.accountUidByCode(l.accountCode)
      } else {
        if (supplier === null) supplier = await getSupplierByUid(this.entity, input.contactId)
        const def = supplier?.defaultExpenseAccount?.uid
        if (!def) throw new Error(`Bill line ${i + 1} has no accountCode and the supplier card has no default expense account`)
        accountUid = def
      }
      builderLines.push({
        description: l.description,
        accountUid,
        // Builder's tax-inclusive path multiplies by (1+rate) — feed it the
        // ex-GST magnitude so the inc amount round-trips to the cent.
        lineTotalExGst: (l.amount || 0) / (1 + taxRate(l.taxType)),
        taxCode: String(l.taxType || 'GST'),
      })
    }
    if (supplier === null) supplier = await getSupplierByUid(this.entity, input.contactId).catch(() => null)

    const { gstUid, freUid } = await ensureTaxCodes(this.entity)
    const totalIncGst = input.totalIncGst ?? round2(neutral.reduce((s, l) => s + (l.amount || 0), 0))
    const { body } = buildServiceBillBody({
      label: `adapter:${input.reference}`,
      invoiceNumber: input.reference,
      invoiceDate: input.dateIso.substring(0, 10),
      supplierUid: input.contactId,
      vendorName: supplier?.name || null,
      isCreditNote: input.isCreditNote === true,
      totalIncGst,
      gstAmount: null,
      subtotalExGst: null,
      lines: builderLines,
      gstUid,
      freUid,
      taxInclusive: true,
    })
    if (input.memo) body.JournalMemo = input.memo.substring(0, 255)
    // NOTE: dueDateIso is accepted for interface parity but not sent —
    // AccountRight derives due dates from the supplier card's terms.

    const r = await myobFetch(c.id, `/accountright/${cfId}/Purchase/Bill/Service`, { method: 'POST', body })
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`MYOB rejected the bill (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    const uid = extractUidFromLocation(r.headers, cfId)
    if (!uid) throw new Error(`MYOB accepted the bill but returned no UID (Location="${r.headers?.['location'] || ''}")`)

    if (input.attachment) {
      // Best-effort, matching every existing MYOB flow — the bill is real
      // in MYOB whether or not the paperclip landed.
      try {
        await this.attachPdf('bill', uid, input.attachment.name, input.attachment.bytes)
      } catch (e: any) {
        console.error(`accounting/myob: bill ${uid} posted but PDF attach failed: ${e?.message || e}`)
      }
    }
    return { id: uid, reference: input.reference }
  }

  async findBillByReference(query: {
    reference: string
    contactId?: string
    expectedTotal?: number
  }): Promise<BillMatch | null> {
    const c = await this.conn()
    const cfId = c.company_file_id!
    if (query.contactId) {
      const m = await findExistingMyobBill(c.id, cfId, query.reference, query.contactId, {
        expectedTotal: query.expectedTotal ?? null,
      })
      return m ? { id: m.uid, number: m.number, reference: query.reference, dateIso: m.date, totalIncGst: m.totalAmount } : null
    }
    // No supplier context — exact SupplierInvoiceNumber match across layouts.
    const escaped = query.reference.replace(/'/g, "''")
    for (const layout of ['Service', 'Item']) {
      const r = await myobFetch(c.id, `/accountright/${cfId}/Purchase/Bill/${layout}`, {
        query: { '$filter': `SupplierInvoiceNumber eq '${escaped}'`, '$top': 10 },
      })
      if (r.status !== 200) continue
      const items: any[] = Array.isArray(r.data?.Items) ? r.data.Items : []
      const hit = query.expectedTotal != null
        ? items.find(b => typeof b?.TotalAmount === 'number' && Math.abs(Math.abs(b.TotalAmount) - Math.abs(query.expectedTotal!)) <= 0.05)
        : items[0]
      if (hit) {
        return {
          id: String(hit.UID || ''),
          number: hit.Number || null,
          reference: hit.SupplierInvoiceNumber || query.reference,
          dateIso: hit.Date || null,
          totalIncGst: typeof hit.TotalAmount === 'number' ? hit.TotalAmount : null,
        }
      }
    }
    return null
  }

  // ── Sale invoices ─────────────────────────────────────────────────────

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    if (!input.lines?.length) throw new Error('createInvoice needs at least one line')
    const c = await this.conn()
    const cfId = c.company_file_id!

    // Service layout with account lines (workshop convention). Every line
    // needs an accountCode — MYOB won't accept an account-less Service line.
    const gstUid = await this.taxUidFor('GST')
    const myobLines: any[] = []
    let subtotal = 0
    let totalTax = 0
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]
      if (!l.accountCode) throw new Error(`Invoice line ${i + 1} needs an accountCode (MYOB Service sales are account lines)`)
      const rate = taxRate(l.taxType)
      const ex = round2((l.amount || 0) / (1 + rate))
      myobLines.push({
        Type: 'Transaction',
        Description: (l.description || '').substring(0, 255) || 'Sale line',
        Account: { UID: await this.accountUidByCode(l.accountCode) },
        Total: ex,
        TaxCode: { UID: rate > 0 ? gstUid : await this.taxUidFor('FRE') },
      })
      subtotal += ex
      totalTax += round2(ex * rate)
    }
    subtotal = round2(subtotal)
    totalTax = round2(totalTax)
    const totalAmount = round2(subtotal + totalTax)

    const body: Record<string, any> = {
      Customer: { UID: input.contactId },
      Date: (input.dateIso || new Date().toISOString()).substring(0, 10),
      Lines: myobLines,
      IsTaxInclusive: false,
      Subtotal: subtotal,
      TotalTax: totalTax,
      TotalAmount: totalAmount,
      JournalMemo: (input.memo || 'JA Portal sale').substring(0, 255),
    }
    if (input.reference) body.CustomerPurchaseOrderNumber = String(input.reference).substring(0, 255)

    // 'draft' → Sale ORDER (no GL impact, converted in MYOB later);
    // 'authorised' → Sale INVOICE. MYOB auto-numbers both.
    const path = `/accountright/${cfId}/Sale/${input.status === 'draft' ? 'Order' : 'Invoice'}/Service`
    const r = await myobFetch(c.id, path, { method: 'POST', body })
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`MYOB Sale POST failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    const uid = extractUidFromLocation(r.headers, cfId)
    if (!uid) throw new Error(`MYOB accepted the sale but returned no UID (Location="${r.headers?.['location'] || ''}")`)

    let number: string | null = null
    try {
      const detail = await myobFetch(c.id, `${path}/${uid}`)
      if (detail.status === 200 && detail.data?.Number) number = String(detail.data.Number)
    } catch { /* not fatal */ }
    return { id: uid, number }
  }

  // ── Payments ──────────────────────────────────────────────────────────

  async applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
    if (!input.invoiceId === !input.billId) throw new Error('applyPayment needs exactly one of invoiceId / billId')
    if (!Number.isFinite(input.amount) || input.amount === 0) throw new Error('applyPayment amount must be non-zero')
    const c = await this.conn()
    const cfId = c.company_file_id!
    const date = input.dateIso.substring(0, 10)

    if (input.billId) {
      if (!input.accountCode) throw new Error('Bill payments need an accountCode (the bank/clearing account paid from)')
      const doc = await this.findDocument('bill', input.billId)
      const supplierUid: string | undefined = doc.data?.Supplier?.UID
      if (!supplierUid) throw new Error(`MYOB bill ${input.billId} has no Supplier UID`)
      const r = await applyBillPayment({
        connId: c.id,
        cfId,
        date,
        fromAccountUid: await this.accountUidByCode(input.accountCode),
        supplierUid,
        billUid: input.billId,
        amount: input.amount,
        memo: input.memo || `Payment — via JA Portal`,
      })
      return { paymentId: r.paymentUid }
    }

    const doc = await this.findDocument('invoice', input.invoiceId!)
    const customerUid: string | undefined = doc.data?.Customer?.UID
    if (!customerUid) throw new Error(`MYOB invoice ${input.invoiceId} has no Customer UID`)
    const body: Record<string, any> = {
      Customer: { UID: customerUid },
      Date: date,
      AmountReceived: input.amount,
      Memo: (input.memo || 'Payment — via JA Portal').substring(0, 255),
      Invoices: [{ UID: input.invoiceId, Type: 'Invoice', AmountApplied: input.amount }],
    }
    if (input.accountCode) {
      body.DepositTo = 'Account'
      body.Account = { UID: await this.accountUidByCode(input.accountCode) }
    } else {
      body.DepositTo = 'UndepositedFunds'
    }
    const r = await myobFetch(c.id, `/accountright/${cfId}/Sale/CustomerPayment`, { method: 'POST', body })
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`MYOB CustomerPayment failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    const uid = extractUidFromLocation(r.headers, cfId)
    if (!uid) throw new Error(`MYOB accepted the payment but returned no UID (Location="${r.headers?.['location'] || ''}")`)
    return { paymentId: uid }
  }

  // ── Credit notes ──────────────────────────────────────────────────────

  async createCreditNote(input: CreateCreditNoteInput): Promise<CreateCreditNoteResult> {
    if (input.kind === 'bill') {
      // Supplier credit = negative Service bill (the MYOB UI's own workflow).
      const r = await this.createBill({
        contactId: input.contactId,
        reference: input.reference || `CN-${(input.dateIso || new Date().toISOString()).substring(0, 10)}`,
        dateIso: input.dateIso || new Date().toISOString(),
        lines: input.lines,
        isCreditNote: true,
        memo: input.memo,
      })
      return { id: r.id, number: null }
    }

    // Sale credit = negative Sale/Invoice/Service (lib/workshop-credit-note
    // convention: negative line Totals + negative envelope).
    if (!input.lines?.length) throw new Error('createCreditNote needs at least one line')
    const c = await this.conn()
    const cfId = c.company_file_id!
    const gstUid = await this.taxUidFor('GST')
    const myobLines: any[] = []
    let subtotal = 0
    let totalTax = 0
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i]
      if (!l.accountCode) throw new Error(`Credit-note line ${i + 1} needs an accountCode`)
      const rate = taxRate(l.taxType)
      const ex = round2(Math.abs(l.amount || 0) / (1 + rate))
      myobLines.push({
        Type: 'Transaction',
        Description: (l.description || '').substring(0, 255) || 'Credit',
        Account: { UID: await this.accountUidByCode(l.accountCode) },
        Total: -ex,
        TaxCode: { UID: rate > 0 ? gstUid : await this.taxUidFor('FRE') },
      })
      subtotal += ex
      totalTax += round2(ex * rate)
    }
    subtotal = round2(subtotal)
    totalTax = round2(totalTax)
    const body: Record<string, any> = {
      Customer: { UID: input.contactId },
      Date: (input.dateIso || new Date().toISOString()).substring(0, 10),
      Lines: myobLines,
      IsTaxInclusive: false,
      Subtotal: -subtotal,
      TotalTax: -totalTax,
      TotalAmount: -round2(subtotal + totalTax),
      JournalMemo: (input.memo || 'Credit note — via JA Portal').substring(0, 255),
    }
    if (input.reference) body.CustomerPurchaseOrderNumber = String(input.reference).substring(0, 255)
    const path = `/accountright/${cfId}/Sale/Invoice/Service`
    const r = await myobFetch(c.id, path, { method: 'POST', body })
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`MYOB credit POST failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    const uid = extractUidFromLocation(r.headers, cfId)
    if (!uid) throw new Error(`MYOB accepted the credit but returned no UID (Location="${r.headers?.['location'] || ''}")`)
    let number: string | null = null
    try {
      const detail = await myobFetch(c.id, `${path}/${uid}`)
      if (detail.status === 200 && detail.data?.Number) number = String(detail.data.Number)
    } catch { /* not fatal */ }
    return { id: uid, number }
  }

  async voidDocument(kind: DocumentKind, id: string): Promise<void> {
    const c = await this.conn()
    const doc = await this.findDocument(kind, id)
    const r = await myobFetch(c.id, doc.path, { method: 'DELETE' })
    if (r.status !== 200 && r.status !== 204) {
      throw new Error(`MYOB DELETE ${kind} failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
  }

  // ── Listing documents ─────────────────────────────────────────────────

  async listInvoices(query: ListInvoicesQuery): Promise<InvoiceRow[]> {
    if (query.kind === 'sale') {
      // Delegate to the reporting lib — it pages every invoice type with
      // NextPageLink and flattens lines (proven against EOFY reconciliation).
      const { invoices, lines } = await fetchSaleInvoicesWithLines(this.entity, {
        start: query.dateFromIso,
        endExclusive: query.dateToIso,
      })
      const linesById = new Map<string, InvoiceLineRow[]>()
      if (query.withLines) {
        for (const l of lines) {
          const row: InvoiceLineRow = {
            description: l.Description,
            amount: Number(l.Total) || 0,
            accountCode: l.AccountDisplayID,
            taxType: l.TaxCodeCode,
            itemCode: l.ItemNumber,
            quantity: l.ShipQuantity,
            unitPrice: l.UnitPrice,
          }
          const arr = linesById.get(l.SaleInvoiceId)
          if (arr) arr.push(row)
          else linesById.set(l.SaleInvoiceId, [row])
        }
      }
      return invoices.map(inv => ({
        id: inv.ID,
        number: inv.Number,
        reference: inv.CustomerPurchaseOrderNumber,
        contactName: inv.CustomerName,
        dateIso: inv.Date,
        totalIncGst: Number(inv.TotalAmount) || 0,
        totalTax: Number(inv.TotalTax) || 0,
        balanceDue: typeof inv.BalanceDueAmount === 'number' ? inv.BalanceDueAmount : null,
        status: inv.Status,
        ...(query.withLines ? { lines: linesById.get(inv.ID) || [] } : {}),
      }))
    }

    // Bills — page Service + Item layouts with a date-range filter.
    const filter = `Date ge ${dt(query.dateFromIso)} and Date lt ${dt(query.dateToIso)}`
    const raw: any[] = []
    for (const layout of ['Service', 'Item']) {
      try {
        raw.push(...await this.pageAll(`Purchase/Bill/${layout}`, { '$filter': filter, '$orderby': 'Number' }))
      } catch (e: any) {
        // A file may not have every layout enabled — first-page 400/404 is fine.
        const msg = String(e?.message || e)
        if (!/HTTP (400|404)/.test(msg)) throw e
      }
    }
    return raw.map(b => ({
      id: String(b.UID || ''),
      number: b.Number || null,
      reference: b.SupplierInvoiceNumber || null,
      contactName: b.Supplier?.Name || null,
      dateIso: b.Date || null,
      totalIncGst: Number(b.TotalAmount) || 0,
      totalTax: Number(b.TotalTax) || 0,
      balanceDue: typeof b.BalanceDueAmount === 'number' ? b.BalanceDueAmount : null,
      status: b.Status || null,
      ...(query.withLines ? {
        lines: (Array.isArray(b.Lines) ? b.Lines : []).map((l: any): InvoiceLineRow => ({
          description: l.Description || null,
          amount: Number(l.Total) || 0,
          accountCode: l.Account?.DisplayID || null,
          taxType: l.TaxCode?.Code || null,
          itemCode: l.Item?.Number || null,
          quantity: l.BillQuantity ?? l.ShipQuantity ?? null,
          unitPrice: l.UnitPrice ?? null,
        })),
      } : {}),
    }))
  }

  // ── Items / inventory ─────────────────────────────────────────────────

  async listItems(query: ListItemsQuery = {}): Promise<AccountingItem[]> {
    const q: Record<string, string | number> = { '$orderby': 'Number' }
    if (query.modifiedSinceIso) {
      const stamp = new Date(query.modifiedSinceIso).toISOString().substring(0, 19)
      q['$filter'] = `LastModified ge datetime'${stamp}'`
    }
    const raw = await this.pageAll('Inventory/Item', q)
    return raw.map(mapItem)
  }

  async getItem(itemId: string): Promise<AccountingItem | null> {
    const c = await this.conn()
    const cf = await this.cfPath()
    const r = await myobFetch(c.id, `${cf}/Inventory/Item/${encodeURIComponent(itemId)}`)
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`MYOB item fetch failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    return mapItem(r.data)
  }

  async updateItem(itemId: string, patch: UpdateItemPatch): Promise<void> {
    if (patch.name === undefined && patch.sellPrice === undefined) return
    const c = await this.conn()
    const cf = await this.cfPath()
    const base = `${cf}/Inventory/Item/${encodeURIComponent(itemId)}`
    // GET-modify-PUT keeps RowVersion + required fields intact
    // (lib/workshop-myob-items.ts convention).
    const got = await myobFetch(c.id, base)
    if (got.status !== 200 || !got.data?.UID) throw new Error(`Couldn't load MYOB item ${itemId} (HTTP ${got.status})`)
    const obj = got.data
    if (patch.name !== undefined) obj.Name = String(patch.name)
    if (patch.sellPrice !== undefined) {
      obj.SellingDetails = obj.SellingDetails || {}
      obj.SellingDetails.BaseSellingPrice = round2(Number(patch.sellPrice) || 0)
    }
    const put = await myobFetch(c.id, base, { method: 'PUT', body: obj })
    if (![200, 201, 204].includes(put.status)) {
      throw new Error(`MYOB item update failed (HTTP ${put.status}): ${myobErrorDetail(put)}`)
    }
  }

  async adjustInventory(input: InventoryAdjustmentInput): Promise<InventoryAdjustmentResult> {
    if (!input.items?.length) throw new Error('adjustInventory needs at least one item')
    if (!input.accountCode) throw new Error('MYOB inventory adjustments need an accountCode (the expense/COGS account the variance posts against)')
    const c = await this.conn()
    const cfId = c.company_file_id!
    const accountUid = await this.accountUidByCode(input.accountCode)
    const body = {
      Date: input.dateIso.substring(0, 10),
      Memo: input.reason.substring(0, 255),
      Lines: input.items.map(it => ({
        Item: { UID: it.itemId },
        Quantity: it.qtyDelta,
        ...(it.unitCost != null ? { UnitCost: round2(it.unitCost) } : {}),
        Account: { UID: accountUid },
        Memo: input.reason.substring(0, 255),
      })),
    }
    const r = await myobFetch(c.id, `/accountright/${cfId}/Inventory/Adjustment`, { method: 'POST', body })
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`MYOB Inventory/Adjustment failed (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
    return { id: extractUidFromLocation(r.headers, cfId) }
  }

  // ── Attachments ───────────────────────────────────────────────────────

  async attachPdf(kind: DocumentKind, id: string, name: string, bytes: Buffer): Promise<void> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`PDF too large (${Math.round(bytes.byteLength / 1024)}KB) — MYOB limit ${Math.round(MAX_ATTACHMENT_BYTES / 1024)}KB`)
    }
    const c = await this.conn()
    const doc = await this.findDocument(kind, id)
    // MYOB 400s on non-ASCII filenames (learnt the hard way — "(p2 of 8)" saga).
    const safeName = (name || 'document.pdf').replace(/[^\x20-\x7E]/g, '_').substring(0, 100)
    const r = await myobFetch(c.id, `${doc.path}/Attachment`, {
      method: 'POST',
      body: { Attachments: [{ OriginalFileName: safeName, FileBase64Content: bytes.toString('base64') }] },
    })
    if (r.status >= 400) {
      throw new Error(`MYOB rejected attachment (HTTP ${r.status}): ${myobErrorDetail(r)}`)
    }
  }

  // ── Health ────────────────────────────────────────────────────────────

  async ping(): Promise<PingResult> {
    const c = await this.conn()
    const r = await myobFetch(c.id, '/accountright', { requiresCfAuth: false })
    if (r.status !== 200) throw new Error(`MYOB ping failed (HTTP ${r.status})`)
    const files: any[] = Array.isArray(r.data) ? r.data : []
    const mine = files.find(f => String(f?.Id || '').toLowerCase() === String(c.company_file_id).toLowerCase())
    return { orgName: mine?.Name || c.company_file_name || this.entity, provider: 'myob' }
  }

  // ── Mapping helpers ───────────────────────────────────────────────────

  private mapSupplier(s: MyobSupplierLite): AccountingContact {
    return {
      id: s.uid,
      kind: 'supplier',
      name: s.name,
      abn: s.abn,
      email: s.email,
      isIndividual: s.isIndividual,
      defaultExpenseAccountCode: s.defaultExpenseAccount?.displayId || null,
    }
  }

  private mapRawContact(it: any, kind: ContactKind): AccountingContact {
    const company = (it?.CompanyName || '').trim()
    const person = [it?.FirstName, it?.LastName].filter(Boolean).join(' ').trim()
    const abn = it?.BuyingDetails?.ABN || it?.SellingDetails?.ABN || null
    const addresses: any[] = Array.isArray(it?.Addresses) ? it.Addresses : []
    const email = addresses.map(a => (a?.Email || '').trim()).find(Boolean) || null
    return {
      id: it.UID,
      kind,
      name: company || person || '(unnamed)',
      abn: abn ? String(abn).replace(/\s/g, '') : null,
      email,
      isIndividual: it.IsIndividual === true,
      defaultExpenseAccountCode: it?.BuyingDetails?.ExpenseAccount?.DisplayID || null,
    }
  }
}

function mapItem(it: any): AccountingItem {
  return {
    id: it.UID,
    code: it.Number || '',
    name: it.Name || '',
    sellPrice: it?.SellingDetails?.BaseSellingPrice != null ? Number(it.SellingDetails.BaseSellingPrice) : null,
    sellPriceIsTaxInclusive: it?.SellingDetails?.IsTaxInclusive === true,
    isTracked: it.IsInventoried === true,
    onHand: it.QuantityOnHand != null ? Number(it.QuantityOnHand) : null,
    isActive: it.IsActive !== false,
  }
}

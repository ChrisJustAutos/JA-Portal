// lib/accounting/xero-adapter.ts
//
// Xero implementation of the neutral AccountingAdapter contract (MYOB→Xero
// migration). One instance per entity label ('VPS' | 'JAWS'); all HTTP goes
// through lib/xero.ts xeroFetch (token refresh, tenant header, 429 retry,
// api-log).
//
// Xero model notes baked into this adapter:
//  • Bills ARE invoices: Type 'ACCPAY'. Sales invoices are 'ACCREC'.
//  • Contacts are unified — there is no separate supplier/customer record.
//    IsSupplier/IsCustomer are READ-ONLY flags Xero derives from transaction
//    history, so `kind` is only a soft preference when filtering matches and
//    is not settable on create.
//  • Amounts are posted LineAmountTypes 'Inclusive' (GST-inc, matching how
//    the MYOB side posts).
//  • Xero JSON dates come back as "/Date(1518685950940+0000)/" — parsed
//    defensively; dates are SENT as plain yyyy-mm-dd strings.
//  • Drafts cannot be VOIDED (must be DELETED); authorised docs cannot be
//    DELETED (must be VOIDED) — voidDocument inspects status and picks.
//  • Tracked-inventory quantity adjustments have NO public API — see
//    adjustInventory.
//
// NOTE on types: lib/accounting/types.ts is being authored separately to the
// same contract. It did not exist when this file was written, so the neutral
// types are declared + exported here; the seam agent will reconcile this file
// to `import ... from './types'` once both halves land.

import { xeroFetch, XeroLabel } from '../xero'

// ---------------------------------------------------------------------------
// Neutral contract types (temporary home — see NOTE above)
// ---------------------------------------------------------------------------

export type ContactKind = 'supplier' | 'customer'
export type DocStatus = 'draft' | 'authorised'
/** Neutral document kinds accepted by voidDocument / attachPdf. */
export type DocumentKind = 'invoice' | 'bill' | 'credit_note'

export interface ContactQuery {
  kind: ContactKind
  name?: string
  abn?: string
  id?: string
}

export interface ContactRef {
  id: string
  name: string
  isSupplier?: boolean
  isCustomer?: boolean
}

export interface CreateContactInput {
  kind: ContactKind
  name: string
  abn?: string
  email?: string
}

/** Neutral tax codes 'GST' | 'FRE' are mapped to Xero AU TaxTypes per
 *  document side; any other string passes through as a raw Xero TaxType. */
export interface NeutralLine {
  description: string
  amount: number            // tax-INCLUSIVE line total
  accountCode?: string      // passes through as Xero AccountCode
  taxType?: string          // 'GST' | 'FRE' | raw Xero TaxType
}

export interface CreateBillInput {
  contactId: string
  reference: string
  dateIso: string
  dueDateIso?: string
  lines?: NeutralLine[]
  singleTotal?: number      // post as one inclusive line when no line detail
  /** Account code for the singleTotal line (Xero requires one to authorise). */
  accountCode?: string
  /** Defaults to 'authorised'. */
  status?: DocStatus
  attachment?: { name: string; bytes: Buffer }
}

export interface CreateBillResult {
  id: string
  reference: string
  /** true = an existing matching bill was adopted instead of double-posting */
  adopted?: boolean
}

export interface BillMatch {
  id: string
  reference: string
  total: number
  status: string
  contactName?: string
}

export interface CreateInvoiceInput {
  contactId: string
  lines: NeutralLine[]
  reference?: string
  status: DocStatus
  dateIso?: string
  dueDateIso?: string
}

export interface CreateCreditNoteInput {
  contactId: string
  /** 'bill' = supplier credit (ACCPAYCREDIT), 'sale' = customer credit (ACCRECCREDIT) */
  kind: 'sale' | 'bill'
  lines: NeutralLine[]
  reference?: string
  dateIso?: string
  status?: DocStatus
}

export interface ApplyPaymentInput {
  invoiceId?: string
  billId?: string
  amount: number
  dateIso: string
  accountCode: string
}

export interface ListInvoicesQuery {
  kind: 'sale' | 'bill'
  dateFromIso: string
  dateToIso: string
  withLines?: boolean
}

export interface InvoiceRow {
  id: string
  number: string
  contactName: string
  dateIso: string
  total: number
  status: string
  lines?: NeutralLine[]
}

export interface ItemRow {
  id: string
  code: string
  name: string
  description?: string
  purchaseDescription?: string
  salesUnitPrice?: number
  purchaseUnitPrice?: number
  salesAccountCode?: string
  purchaseAccountCode?: string
  isTracked?: boolean
  quantityOnHand?: number
  updatedIso?: string
}

export interface AdjustInventoryInput {
  itemId: string
  quantityDelta: number
  reason?: string
}

export interface AccountingAdapter {
  findContact(query: ContactQuery): Promise<ContactRef | null>
  createContact(input: CreateContactInput): Promise<ContactRef>
  createBill(input: CreateBillInput): Promise<CreateBillResult>
  findBillByReference(contactId: string | null, reference: string, expectedTotal?: number): Promise<BillMatch | null>
  createInvoice(input: CreateInvoiceInput): Promise<{ id: string; number: string }>
  applyPayment(input: ApplyPaymentInput): Promise<{ id: string }>
  createCreditNote(input: CreateCreditNoteInput): Promise<{ id: string; number?: string }>
  voidDocument(kind: DocumentKind, id: string): Promise<void>
  listInvoices(query: ListInvoicesQuery): Promise<InvoiceRow[]>
  listItems(query?: { modifiedSinceIso?: string }): Promise<ItemRow[]>
  getItem(id: string): Promise<ItemRow | null>
  updateItem(id: string, fields: Partial<Omit<ItemRow, 'id'>>): Promise<ItemRow>
  adjustInventory(input: AdjustInventoryInput): Promise<void>
  attachPdf(kind: DocumentKind, id: string, name: string, bytes: Buffer): Promise<void>
  ping(): Promise<string>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOTAL_TOLERANCE = 0.05 // duplicate-adopt when totals agree within 5c

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Quote + escape a string literal for a Xero `where` expression. */
function q(s: string): string {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** yyyy-mm-dd → Xero where-clause DateTime(y,m,d). */
function whereDate(iso: string): string {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) throw new Error(`Bad ISO date for Xero where clause: ${iso}`)
  return `DateTime(${y},${m},${d})`
}

/** Send dates to Xero as plain yyyy-mm-dd (accepted on writes). */
function isoDateOnly(iso: string): string {
  return String(iso).slice(0, 10)
}

/** Parse Xero's "/Date(1518685950940+0000)/" (or ISO) → yyyy-mm-dd ('' if unparseable). */
export function parseXeroDate(v: any): string {
  if (!v) return ''
  const s = String(v)
  const m = s.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//)
  if (m) {
    const d = new Date(Number(m[1]))
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }
  const d = new Date(s)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * Neutral tax code → Xero AU TaxType, parameterised by document side.
 *   GST → INPUT (purchases) / OUTPUT (sales)
 *   FRE → EXEMPTEXPENSES (purchases) / EXEMPTOUTPUT (sales)
 * Anything else is passed through untouched (assumed to already be a Xero
 * TaxType, e.g. 'BASEXCLUDED').
 */
export function mapTaxType(neutral: string | undefined, side: 'purchase' | 'sale'): string | undefined {
  if (!neutral) return undefined
  const t = neutral.trim().toUpperCase()
  if (t === 'GST') return side === 'purchase' ? 'INPUT' : 'OUTPUT'
  if (t === 'FRE') return side === 'purchase' ? 'EXEMPTEXPENSES' : 'EXEMPTOUTPUT'
  return neutral
}

function toContactRef(c: any): ContactRef {
  return {
    id: c.ContactID,
    name: c.Name || '',
    isSupplier: !!c.IsSupplier,
    isCustomer: !!c.IsCustomer,
  }
}

function toLineItems(lines: NeutralLine[], side: 'purchase' | 'sale'): any[] {
  return lines.map(l => ({
    Description: l.description || '(no description)',
    Quantity: 1,
    UnitAmount: round2(l.amount),
    ...(l.accountCode ? { AccountCode: l.accountCode } : {}),
    ...(mapTaxType(l.taxType, side) ? { TaxType: mapTaxType(l.taxType, side) } : {}),
  }))
}

function toItemRow(it: any): ItemRow {
  return {
    id: it.ItemID,
    code: it.Code || '',
    name: it.Name || it.Code || '',
    description: it.Description || undefined,
    purchaseDescription: it.PurchaseDescription || undefined,
    salesUnitPrice: it.SalesDetails?.UnitPrice != null ? Number(it.SalesDetails.UnitPrice) : undefined,
    purchaseUnitPrice: it.PurchaseDetails?.UnitPrice != null ? Number(it.PurchaseDetails.UnitPrice) : undefined,
    salesAccountCode: it.SalesDetails?.AccountCode || undefined,
    purchaseAccountCode: it.PurchaseDetails?.AccountCode || it.PurchaseDetails?.COGSAccountCode || undefined,
    isTracked: !!it.IsTrackedAsInventory,
    quantityOnHand: it.QuantityOnHand != null ? Number(it.QuantityOnHand) : undefined,
    updatedIso: parseXeroDate(it.UpdatedDateUTC) || undefined,
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class XeroAdapter implements AccountingAdapter {
  constructor(private readonly label: XeroLabel) {}

  // --- Contacts ------------------------------------------------------------

  async findContact(query: ContactQuery): Promise<ContactRef | null> {
    // Direct lookup by Xero ContactID.
    if (query.id) {
      try {
        const j = await xeroFetch(this.label, `/Contacts/${encodeURIComponent(query.id)}`)
        const c = j?.Contacts?.[0]
        return c ? toContactRef(c) : null
      } catch {
        return null // 404 → not found rather than throw
      }
    }

    const pick = (contacts: any[]): ContactRef | null => {
      if (!contacts?.length) return null
      // Xero contacts are unified — prefer one flagged with the requested
      // kind, but do NOT hard-fail if the flag isn't set (a fresh contact
      // has neither flag until its first transaction).
      const flag = query.kind === 'supplier' ? 'IsSupplier' : 'IsCustomer'
      const flagged = contacts.find(c => !!c[flag])
      return toContactRef(flagged || contacts[0])
    }

    if (query.abn) {
      const abn = query.abn.trim()
      const j = await xeroFetch(this.label,
        `/Contacts?where=${encodeURIComponent(`TaxNumber==${q(abn)}`)}`)
      const hit = pick(j?.Contacts || [])
      if (hit) return hit
      // fall through to name if ABN found nothing and a name was supplied
    }

    if (query.name) {
      const name = query.name.trim()
      // Exact (case-insensitive) match first.
      const j = await xeroFetch(this.label,
        `/Contacts?where=${encodeURIComponent(`Name.ToLower()==${q(name.toLowerCase())}`)}`)
      const exact = pick(j?.Contacts || [])
      if (exact) return exact
      // Fuzzy fallback via searchTerm (name/email/etc contains).
      const j2 = await xeroFetch(this.label,
        `/Contacts?searchTerm=${encodeURIComponent(name)}&page=1`)
      return pick(j2?.Contacts || [])
    }

    return null
  }

  async createContact(input: CreateContactInput): Promise<ContactRef> {
    // NOTE: IsSupplier/IsCustomer are read-only in Xero (derived from
    // transaction history) — input.kind cannot be persisted on create.
    const body = {
      Contacts: [{
        Name: input.name.trim(),
        ...(input.abn ? { TaxNumber: input.abn.trim() } : {}),
        ...(input.email ? { EmailAddress: input.email.trim() } : {}),
      }],
    }
    const j = await xeroFetch(this.label, '/Contacts', { method: 'PUT', body: JSON.stringify(body) })
    const c = j?.Contacts?.[0]
    if (!c?.ContactID) throw new Error(`Xero createContact: no ContactID in response (${JSON.stringify(j).slice(0, 200)})`)
    return toContactRef(c)
  }

  // --- Bills (ACCPAY invoices) ----------------------------------------------

  async findBillByReference(contactId: string | null, reference: string, expectedTotal?: number): Promise<BillMatch | null> {
    const clauses = [
      'Type=="ACCPAY"',
      `InvoiceNumber==${q(reference.trim())}`,
      'Status!="DELETED"',
      'Status!="VOIDED"',
    ]
    if (contactId) clauses.push(`Contact.ContactID==Guid(${q(contactId)})`)
    const j = await xeroFetch(this.label,
      `/Invoices?where=${encodeURIComponent(clauses.join(' AND '))}`)
    const invoices: any[] = j?.Invoices || []
    for (const inv of invoices) {
      const total = round2(Number(inv.Total || 0))
      if (expectedTotal != null && Math.abs(total - round2(expectedTotal)) > TOTAL_TOLERANCE) continue
      return {
        id: inv.InvoiceID,
        reference: inv.InvoiceNumber || reference,
        total,
        status: inv.Status || '',
        contactName: inv.Contact?.Name || undefined,
      }
    }
    return null
  }

  async createBill(input: CreateBillInput): Promise<CreateBillResult> {
    const reference = input.reference.trim()
    const expectedTotal = input.singleTotal != null
      ? round2(input.singleTotal)
      : round2((input.lines || []).reduce((s, l) => s + Number(l.amount || 0), 0))

    // Duplicate-adopt: if a live ACCPAY invoice with this reference (same
    // contact) already exists and its total agrees within 5c, adopt it
    // instead of double-posting.
    const existing = await this.findBillByReference(input.contactId, reference, expectedTotal)
    if (existing) {
      return { id: existing.id, reference: existing.reference, adopted: true }
    }

    let lineItems: any[]
    if (input.lines?.length) {
      lineItems = toLineItems(input.lines, 'purchase')
    } else if (input.singleTotal != null) {
      lineItems = toLineItems([{
        description: `Per supplier invoice ${reference}`,
        amount: input.singleTotal,
        accountCode: input.accountCode,
        taxType: 'GST',
      }], 'purchase')
    } else {
      throw new Error('createBill: either lines or singleTotal is required')
    }

    const body = {
      Invoices: [{
        Type: 'ACCPAY',
        Contact: { ContactID: input.contactId },
        InvoiceNumber: reference,
        Date: isoDateOnly(input.dateIso),
        ...(input.dueDateIso ? { DueDate: isoDateOnly(input.dueDateIso) } : {}),
        LineAmountTypes: 'Inclusive',
        LineItems: lineItems,
        Status: input.status === 'draft' ? 'DRAFT' : 'AUTHORISED',
      }],
    }
    const j = await xeroFetch(this.label, '/Invoices', { method: 'POST', body: JSON.stringify(body) })
    const inv = j?.Invoices?.[0]
    if (!inv?.InvoiceID) throw new Error(`Xero createBill: no InvoiceID in response (${JSON.stringify(j).slice(0, 200)})`)

    if (input.attachment) {
      // Attachment failure should not roll back the bill — surface softly.
      try {
        await this.attachPdf('bill', inv.InvoiceID, input.attachment.name, input.attachment.bytes)
      } catch (e: any) {
        console.warn(`[xero-adapter:${this.label}] bill ${reference} posted but attachment failed: ${e?.message || e}`)
      }
    }

    return { id: inv.InvoiceID, reference: inv.InvoiceNumber || reference }
  }

  // --- Sales invoices (ACCREC) -----------------------------------------------

  async createInvoice(input: CreateInvoiceInput): Promise<{ id: string; number: string }> {
    const body = {
      Invoices: [{
        Type: 'ACCREC',
        Contact: { ContactID: input.contactId },
        ...(input.reference ? { Reference: input.reference } : {}),
        Date: isoDateOnly(input.dateIso || new Date().toISOString()),
        ...(input.dueDateIso ? { DueDate: isoDateOnly(input.dueDateIso) } : {}),
        LineAmountTypes: 'Inclusive',
        LineItems: toLineItems(input.lines, 'sale'),
        Status: input.status === 'draft' ? 'DRAFT' : 'AUTHORISED',
      }],
    }
    const j = await xeroFetch(this.label, '/Invoices', { method: 'POST', body: JSON.stringify(body) })
    const inv = j?.Invoices?.[0]
    if (!inv?.InvoiceID) throw new Error(`Xero createInvoice: no InvoiceID in response (${JSON.stringify(j).slice(0, 200)})`)
    return { id: inv.InvoiceID, number: inv.InvoiceNumber || '' }
  }

  // --- Payments ---------------------------------------------------------------

  async applyPayment(input: ApplyPaymentInput): Promise<{ id: string }> {
    const targetId = input.invoiceId || input.billId
    if (!targetId) throw new Error('applyPayment: invoiceId or billId is required')
    // Bills and sales invoices are both /Invoices in Xero — one payment shape.
    const body = {
      Payments: [{
        Invoice: { InvoiceID: targetId },
        Account: { Code: input.accountCode },
        Date: isoDateOnly(input.dateIso),
        Amount: round2(input.amount),
      }],
    }
    const j = await xeroFetch(this.label, '/Payments', { method: 'PUT', body: JSON.stringify(body) })
    const p = j?.Payments?.[0]
    if (!p?.PaymentID) throw new Error(`Xero applyPayment: no PaymentID in response (${JSON.stringify(j).slice(0, 200)})`)
    return { id: p.PaymentID }
  }

  // --- Credit notes -------------------------------------------------------------

  async createCreditNote(input: CreateCreditNoteInput): Promise<{ id: string; number?: string }> {
    const side: 'purchase' | 'sale' = input.kind === 'bill' ? 'purchase' : 'sale'
    const body = {
      CreditNotes: [{
        Type: input.kind === 'bill' ? 'ACCPAYCREDIT' : 'ACCRECCREDIT',
        Contact: { ContactID: input.contactId },
        ...(input.reference ? { Reference: input.reference } : {}),
        Date: isoDateOnly(input.dateIso || new Date().toISOString()),
        LineAmountTypes: 'Inclusive',
        LineItems: toLineItems(input.lines, side),
        Status: input.status === 'draft' ? 'DRAFT' : 'AUTHORISED',
      }],
    }
    const j = await xeroFetch(this.label, '/CreditNotes', { method: 'POST', body: JSON.stringify(body) })
    const cn = j?.CreditNotes?.[0]
    if (!cn?.CreditNoteID) throw new Error(`Xero createCreditNote: no CreditNoteID in response (${JSON.stringify(j).slice(0, 200)})`)
    return { id: cn.CreditNoteID, number: cn.CreditNoteNumber || undefined }
  }

  // --- Void / delete --------------------------------------------------------------

  async voidDocument(kind: DocumentKind, id: string): Promise<void> {
    // Xero rule: DRAFT/SUBMITTED docs must be DELETED; AUTHORISED docs must
    // be VOIDED. Read the current status first and pick the right terminal
    // state. Bills and sales invoices are both /Invoices.
    const base = kind === 'credit_note' ? 'CreditNotes' : 'Invoices'
    const cur = await xeroFetch(this.label, `/${base}/${encodeURIComponent(id)}`)
    const doc = kind === 'credit_note' ? cur?.CreditNotes?.[0] : cur?.Invoices?.[0]
    if (!doc) throw new Error(`voidDocument: ${kind} ${id} not found in Xero`)
    const status = String(doc.Status || '').toUpperCase()
    if (status === 'VOIDED' || status === 'DELETED') return // already terminal
    if (status === 'PAID') throw new Error(`voidDocument: ${kind} ${id} is PAID — remove payments/allocations in Xero first`)
    const target = (status === 'DRAFT' || status === 'SUBMITTED') ? 'DELETED' : 'VOIDED'
    await xeroFetch(this.label, `/${base}/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ Status: target }),
    })
  }

  // --- Listing ---------------------------------------------------------------------

  async listInvoices(query: ListInvoicesQuery): Promise<InvoiceRow[]> {
    const type = query.kind === 'bill' ? 'ACCPAY' : 'ACCREC'
    const where = [
      `Type=="${type}"`,
      `Date>=${whereDate(query.dateFromIso)}`,
      `Date<=${whereDate(query.dateToIso)}`,
      'Status!="DELETED"',
    ].join(' AND ')

    const rows: InvoiceRow[] = []
    const side: 'purchase' | 'sale' = query.kind === 'bill' ? 'purchase' : 'sale'
    void side // (lines come back with raw Xero TaxTypes; no reverse-mapping needed for neutral rows)

    // Paged: Xero includes LineItems only when the page parameter is used.
    // summaryOnly=True trims payloads when lines aren't wanted.
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({
        where,
        order: 'Date',
        page: String(page),
        pageSize: '100',
      })
      if (!query.withLines) params.set('summaryOnly', 'True')
      const j = await xeroFetch(this.label, `/Invoices?${params.toString()}`)
      const batch: any[] = j?.Invoices || []
      for (const inv of batch) {
        rows.push({
          id: inv.InvoiceID,
          number: inv.InvoiceNumber || inv.Reference || '',
          contactName: inv.Contact?.Name || '',
          dateIso: parseXeroDate(inv.Date || inv.DateString),
          total: round2(Number(inv.Total || 0)),
          status: inv.Status || '',
          ...(query.withLines ? {
            lines: (inv.LineItems || []).map((l: any): NeutralLine => ({
              description: l.Description || '',
              amount: round2(Number(l.LineAmount || 0) + Number(l.TaxAmount || 0)), // back to inclusive
              accountCode: l.AccountCode || undefined,
              taxType: l.TaxType || undefined,
            })),
          } : {}),
        })
      }
      if (batch.length < 100) break
    }
    return rows
  }

  // --- Items -----------------------------------------------------------------------

  async listItems(query?: { modifiedSinceIso?: string }): Promise<ItemRow[]> {
    // /Items is not paged (returns all); If-Modified-Since filters by
    // UpdatedDateUTC server-side.
    const headers: Record<string, string> = {}
    if (query?.modifiedSinceIso) {
      headers['If-Modified-Since'] = new Date(query.modifiedSinceIso).toUTCString()
    }
    const j = await xeroFetch(this.label, '/Items', { headers })
    return (j?.Items || []).map(toItemRow)
  }

  async getItem(id: string): Promise<ItemRow | null> {
    try {
      // Xero accepts ItemID or Code in the path segment.
      const j = await xeroFetch(this.label, `/Items/${encodeURIComponent(id)}`)
      const it = j?.Items?.[0]
      return it ? toItemRow(it) : null
    } catch {
      return null
    }
  }

  async updateItem(id: string, fields: Partial<Omit<ItemRow, 'id'>>): Promise<ItemRow> {
    // Xero POST /Items/{id} requires Code in the payload — GET-merge first
    // (same GET-modify-PUT discipline as the MYOB inventory editor).
    const current = await this.getItem(id)
    if (!current) throw new Error(`updateItem: Xero item ${id} not found`)

    if (fields.quantityOnHand != null && fields.quantityOnHand !== current.quantityOnHand) {
      throw new Error('updateItem: QuantityOnHand is read-only in Xero — see adjustInventory for the limitation')
    }

    const body: any = {
      ItemID: current.id,
      Code: fields.code ?? current.code,
    }
    if (fields.name != null) body.Name = fields.name
    if (fields.description != null) body.Description = fields.description
    if (fields.purchaseDescription != null) body.PurchaseDescription = fields.purchaseDescription
    if (fields.salesUnitPrice != null || fields.salesAccountCode != null) {
      body.SalesDetails = {
        ...(fields.salesUnitPrice != null ? { UnitPrice: round2(fields.salesUnitPrice) } : {}),
        ...(fields.salesAccountCode != null ? { AccountCode: fields.salesAccountCode } : {}),
      }
    }
    if (fields.purchaseUnitPrice != null || fields.purchaseAccountCode != null) {
      body.PurchaseDetails = {
        ...(fields.purchaseUnitPrice != null ? { UnitPrice: round2(fields.purchaseUnitPrice) } : {}),
        // For tracked items Xero uses COGSAccountCode on the purchase side;
        // untracked items use AccountCode.
        ...(fields.purchaseAccountCode != null
          ? (current.isTracked ? { COGSAccountCode: fields.purchaseAccountCode } : { AccountCode: fields.purchaseAccountCode })
          : {}),
      }
    }

    const j = await xeroFetch(this.label, `/Items/${encodeURIComponent(current.id)}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const it = j?.Items?.[0]
    if (!it?.ItemID) throw new Error(`Xero updateItem: no ItemID in response (${JSON.stringify(j).slice(0, 200)})`)
    return toItemRow(it)
  }

  async adjustInventory(_input: AdjustInventoryInput): Promise<void> {
    throw new Error(
      'Xero has no inventory-adjustment API: tracked-item quantities can only change via ' +
      'posted purchases (bills) or sales (invoices) — the manual "inventory adjustment" in the ' +
      'Xero UI is not exposed to the public API. Decision pending on stock authority for the ' +
      'MYOB→Xero migration (portal-side stock ledger vs. posting balancing bills). ' +
      'adjustInventory is intentionally unimplemented on XeroAdapter.'
    )
  }

  // --- Attachments -------------------------------------------------------------------

  async attachPdf(kind: DocumentKind, id: string, name: string, bytes: Buffer): Promise<void> {
    const base = kind === 'credit_note' ? 'CreditNotes' : 'Invoices' // bills are Invoices too
    const safeName = encodeURIComponent(name.endsWith('.pdf') ? name : `${name}.pdf`)
    await xeroFetch(this.label, `/${base}/${encodeURIComponent(id)}/Attachments/${safeName}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: bytes as unknown as BodyInit, // raw bytes, NOT json
    })
  }

  // --- Health --------------------------------------------------------------------------

  async ping(): Promise<string> {
    const j = await xeroFetch(this.label, '/Organisation')
    const org = j?.Organisations?.[0]
    if (!org) throw new Error('Xero ping: no organisation in response')
    return org.Name || org.LegalName || 'connected (unnamed organisation)'
  }
}

/** Convenience factory mirroring how the MYOB adapter is expected to be built. */
export function xeroAdapter(label: XeroLabel): AccountingAdapter {
  return new XeroAdapter(label)
}

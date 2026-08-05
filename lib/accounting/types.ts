// lib/accounting/types.ts
//
// Provider-agnostic accounting interface for the MYOB → Xero migration.
//
// Business code that today calls lib/ap-myob-*.ts / lib/workshop-myob-*.ts /
// lib/b2b-myob-*.ts directly should, module by module, move to:
//
//   const acc = await getAccountingAdapter('VPS', 'AP')
//   await acc.createBill({ ... })
//
// The factory (lib/accounting/index.ts) consults accountingProvider()
// (lib/accounting-provider.ts — THE SWITCH) and hands back either the MYOB
// adapter (lib/accounting/myob-adapter.ts) or the Xero adapter
// (lib/accounting/xero-adapter.ts).
//
// Shape conventions (every adapter must honour these):
//   - Dates are ISO strings. Plain dates are 'YYYY-MM-DD'; timestamps are
//     full ISO 8601. Adapters translate to provider formats internally.
//   - Money is NUMBERS IN DOLLARS (never cents).
//   - Document line `amount` is the GST-INCLUSIVE line total. Adapters that
//     store ex-GST internally (MYOB Service layouts) do the division — the
//     caller never thinks about IsTaxInclusive.
//   - `accountCode` is the human chart code ('5-1000', '4-2000'), never a
//     provider UID/ID. Adapters resolve codes to their internal ids.
//   - Ids (`contactId`, `billId`, `itemId`, …) are provider-native opaque
//     strings (MYOB UID / Xero *ID). They are NOT portable across providers —
//     callers persisting them should also record which provider minted them.
//   - taxType is the neutral pair 'GST' | 'FRE' (10% / GST-free). Adapters
//     map to MYOB TaxCode UIDs / Xero TaxTypes (OUTPUT/INPUT/EXEMPT…).

import type { AccountingEntity, AccountingProviderName } from '../accounting-provider'

export type { AccountingEntity, AccountingProviderName }

// ── Shared primitives ───────────────────────────────────────────────────

export type TaxType = 'GST' | 'FRE'

export type ContactKind = 'supplier' | 'customer'

/** Which register a document lives in. 'invoice' = sale invoice (money in),
 *  'bill' = supplier bill (money out), 'creditNote' = sale-side credit. */
export type DocumentKind = 'invoice' | 'bill' | 'creditNote'

export interface DocumentLineInput {
  description: string
  /** GST-INCLUSIVE line total, dollars. Negative allowed on credit lines. */
  amount: number
  /** Chart-of-accounts code, e.g. '5-1000'. Optional where the adapter has
   *  a sensible default (e.g. MYOB supplier card's default expense account
   *  on bills); sale invoices generally require it. */
  accountCode?: string
  /** Defaults to 'GST'. */
  taxType?: TaxType
}

export interface PdfAttachmentInput {
  name: string
  bytes: Buffer
}

// ── Contacts ────────────────────────────────────────────────────────────

export interface ContactQuery {
  /** Provider-native contact id — wins over name/abn when supplied. */
  id?: string
  name?: string
  abn?: string
}

export interface AccountingContact {
  id: string
  kind: ContactKind
  name: string
  abn: string | null
  email: string | null
  isIndividual: boolean
  /** Default purchase/expense account code on the card, when the provider
   *  exposes one (MYOB supplier cards do; Xero contacts may not). */
  defaultExpenseAccountCode: string | null
}

export interface CreateContactInput {
  name: string
  abn?: string | null
  email?: string | null
  phone?: string | null
  /** Default tax treatment on the card. Defaults to 'GST'. */
  taxType?: TaxType
  address?: {
    street?: string | null
    city?: string | null
    state?: string | null
    postcode?: string | null
    country?: string | null
  }
}

// ── Supplier bills ──────────────────────────────────────────────────────

export interface CreateBillInput {
  contactId: string
  /** Supplier invoice number — also the idempotency key for smart-adopt. */
  reference: string
  dateIso: string
  dueDateIso?: string
  /** Itemised lines. Provide either `lines` or `singleTotal`, not both. */
  lines?: DocumentLineInput[]
  /** Consolidated single-line entry at a stated GST-inclusive total (the
   *  ap-consolidated-suppliers pattern). */
  singleTotal?: {
    amount: number
    description?: string
    accountCode?: string
    taxType?: TaxType
  }
  /** Authoritative GST-inclusive document total. When set, adapters must
   *  reconcile the posted document to this to the cent (MYOB nudges the
   *  largest line, à la lib/ap-myob-bill). Defaults to the line sum. */
  totalIncGst?: number
  /** Marks the whole document a supplier credit (posted with negated
   *  amounts on providers without a purchase-credit entity). Magnitudes in
   *  `lines`/`singleTotal` stay POSITIVE — the adapter applies the sign. */
  isCreditNote?: boolean
  attachment?: PdfAttachmentInput
  /** Free-text journal memo / narration. */
  memo?: string
}

export interface CreateBillResult {
  id: string
  reference: string
  /** true = an existing document with the same reference + contact was
   *  found and adopted instead of creating a duplicate. */
  adopted?: boolean
}

export interface FindBillQuery {
  reference: string
  /** Narrow the match to one supplier (strongly recommended — references
   *  are only unique per supplier). */
  contactId?: string
  /** When set, loose-reference matches must also agree on total (±5c). */
  expectedTotal?: number
}

export interface BillMatch {
  id: string
  /** Provider's own document number (not the supplier reference). */
  number: string | null
  reference: string | null
  dateIso: string | null
  totalIncGst: number | null
}

// ── Sale invoices ───────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  contactId: string
  lines: DocumentLineInput[]
  /** Customer PO / order reference, when there is one. */
  reference?: string
  /** Defaults to today. */
  dateIso?: string
  /** 'draft' = no GL impact yet (MYOB: Sale Order; Xero: DRAFT invoice).
   *  'authorised' = posted to the ledger. */
  status: 'draft' | 'authorised'
  memo?: string
}

export interface CreateInvoiceResult {
  id: string
  /** Provider-assigned document number (auto-numbered). */
  number: string | null
}

// ── Payments ────────────────────────────────────────────────────────────

export interface ApplyPaymentInput {
  /** Exactly one of invoiceId / billId. */
  invoiceId?: string
  billId?: string
  /** Dollars. Negative = refund leg (provider permitting). */
  amount: number
  dateIso: string
  /** Bank / clearing account the money moves through. Required for bill
   *  payments; optional for sale payments where the provider has an
   *  undeposited-funds default (MYOB does). */
  accountCode?: string
  memo?: string
}

export interface ApplyPaymentResult {
  paymentId: string
}

// ── Credit notes ────────────────────────────────────────────────────────

export interface CreateCreditNoteInput {
  /** 'sale' credits a customer; 'bill' credits a supplier. */
  kind: 'sale' | 'bill'
  contactId: string
  /** POSITIVE magnitudes — the adapter applies the credit sign. */
  lines: DocumentLineInput[]
  reference?: string
  dateIso?: string
  memo?: string
}

export interface CreateCreditNoteResult {
  id: string
  number: string | null
}

// ── Listing documents ───────────────────────────────────────────────────

export interface ListInvoicesQuery {
  kind: 'sale' | 'bill'
  /** Inclusive start date, 'YYYY-MM-DD'. */
  dateFromIso: string
  /** EXCLUSIVE end date, 'YYYY-MM-DD' — [from, to). */
  dateToIso: string
  withLines?: boolean
}

export interface InvoiceLineRow {
  description: string | null
  /** Line total as the provider reports it, dollars. */
  amount: number
  accountCode: string | null
  taxType: string | null
  itemCode: string | null
  quantity: number | null
  unitPrice: number | null
}

export interface InvoiceRow {
  id: string
  number: string | null
  /** Customer PO (sales) / supplier invoice number (bills). */
  reference: string | null
  contactName: string | null
  dateIso: string | null
  totalIncGst: number
  totalTax: number
  balanceDue: number | null
  status: string | null
  /** Populated only when the query asked withLines. */
  lines?: InvoiceLineRow[]
}

// ── Items / inventory ───────────────────────────────────────────────────

export interface ListItemsQuery {
  /** Only items modified at/after this ISO timestamp. */
  modifiedSinceIso?: string
}

export interface AccountingItem {
  id: string
  /** SKU / item number. */
  code: string
  name: string
  /** Base sell price as stored by the provider, dollars. See
   *  sellPriceIsTaxInclusive for how to read it. */
  sellPrice: number | null
  sellPriceIsTaxInclusive: boolean
  /** true = quantities are tracked (MYOB IsInventoried / Xero tracked). */
  isTracked: boolean
  onHand: number | null
  isActive: boolean
}

export interface UpdateItemPatch {
  name?: string
  /** Written in the provider's own stored convention (see
   *  AccountingItem.sellPriceIsTaxInclusive). */
  sellPrice?: number
}

export interface InventoryAdjustmentInput {
  items: Array<{
    itemId: string
    /** Positive = stock found, negative = shrinkage. */
    qtyDelta: number
    unitCost?: number
  }>
  dateIso: string
  reason: string
  /** Expense/COGS account the adjustment posts against. Required by MYOB;
   *  adapters throw a clear error when they need it and it's absent. */
  accountCode?: string
}

export interface InventoryAdjustmentResult {
  id: string | null
}

// ── Ping ────────────────────────────────────────────────────────────────

export interface PingResult {
  orgName: string
  provider: AccountingProviderName
}

// ── The adapter contract ────────────────────────────────────────────────

export interface AccountingAdapter {
  readonly provider: AccountingProviderName
  readonly entity: AccountingEntity

  // Contacts
  findContact(kind: ContactKind, query: ContactQuery): Promise<AccountingContact | null>
  createContact(kind: ContactKind, input: CreateContactInput): Promise<AccountingContact>

  // Supplier bills
  createBill(input: CreateBillInput): Promise<CreateBillResult>
  findBillByReference(query: FindBillQuery): Promise<BillMatch | null>

  // Sale invoices
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>

  // Payments
  applyPayment(input: ApplyPaymentInput): Promise<ApplyPaymentResult>

  // Credits / voiding
  createCreditNote(input: CreateCreditNoteInput): Promise<CreateCreditNoteResult>
  voidDocument(kind: DocumentKind, id: string): Promise<void>

  // Reporting reads
  listInvoices(query: ListInvoicesQuery): Promise<InvoiceRow[]>

  // Items / inventory
  listItems(query?: ListItemsQuery): Promise<AccountingItem[]>
  getItem(itemId: string): Promise<AccountingItem | null>
  updateItem(itemId: string, patch: UpdateItemPatch): Promise<void>
  adjustInventory(input: InventoryAdjustmentInput): Promise<InventoryAdjustmentResult>

  // Attachments
  attachPdf(kind: DocumentKind, id: string, name: string, bytes: Buffer): Promise<void>

  // Health
  ping(): Promise<PingResult>
}

/** Factory signature — implemented in lib/accounting/index.ts. */
export type GetAccountingAdapter = (
  entity: AccountingEntity,
  module?: string,
) => Promise<AccountingAdapter>

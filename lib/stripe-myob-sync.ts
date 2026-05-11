// lib/stripe-myob-sync.ts
//
// Maps a Stripe invoice into the MYOB JAWS Sale.Invoice/Professional +
// CustomerPayment pair that the (broken) Make automation used to create.
//
// Make's pattern, replicated exactly:
//   1. POST /Sale/Invoice/Professional with TWO lines:
//        a. Sale revenue line (positive, GST inclusive)
//        b. "Stripe Fee" line (negative, account 6-1350, GST inclusive)
//      Invoice TotalAmount nets to the actual Stripe payout amount.
//   2. POST /Sale/CustomerPayment with:
//        DepositTo=UndepositedFunds, Account=1-1210, PaymentMethod=Visa,
//        AmountReceived = invoice net, Memo containing the Stripe invoice id.
//   3. Idempotency: Stripe invoice id is embedded in JournalMemo + Memo, and
//      we additionally record every push in `stripe_myob_sync_log` so re-runs
//      are no-ops.
//
// Customer matching policy:
//   - Search MYOB by name tokens (CompanyName, FirstName, LastName).
//   - If exactly one active match, reuse it.
//   - If zero matches, create a new customer card with the Stripe name +
//     email (per the user's "auto-create" preference).
//   - If multiple matches and the caller didn't pass an override, refuse
//     to push that row — the dry-run surfaces the ambiguity for human review.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import {
  StripeAccountLabel,
  StripeInvoiceLite,
  StripeBalanceTxLite,
  retrieveBalanceTransaction,
  retrieveCharge,
  retrievePaymentIntent,
  retrieveInvoice,
  listChargesForInvoice,
} from './stripe-multi'

// ── Constants: JAWS company file UIDs ──────────────────────────────────
// Pulled from real Make-created invoices via the inspect-jaws-invoices
// diagnostic endpoint. UIDs are stable for the life of the account; if
// JAWS ever recreates an account this would need to be re-mapped (and
// the diagnostic endpoint makes that a 5-minute job).
export const JAWS_UIDS = {
  TAX_CODE_GST:        '839eb531-1491-45aa-9571-aac88d2cb2b0',
  ACCT_STRIPE_FEE:     '4cae35d7-c8f7-4b12-b94a-f147283d0132',  // 6-1350
  ACCT_UNDEP_FUNDS:    'e5df6e92-04b6-41ab-876f-be55abc7fa1d',  // 1-1210
  // Sale-revenue accounts. Make appears to vary these per product —
  // for the backfill we default to "Tuning - Default" and surface the
  // choice in dry-run output so the user can override per-row.
  ACCT_TUNING_DEFAULT: 'c3e47c87-b04c-4eed-896f-0f5930beab45',  // 4-1920
  ACCT_MULTIMAP:       '76491034-2115-4faf-80f9-b052c6a6a420',  // 4-1910
  ACCT_EASY_LOCK:      'fa2d1a03-ec24-4da9-9e63-044240df4157',  // 4-1915
  ACCT_REMAP:          'c8dbc437-cd2a-4daf-aed4-0076283dfde6',  // 4-1905
} as const

// ── Supabase (service-role) ─────────────────────────────────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Types ───────────────────────────────────────────────────────────────

export interface PushPreview {
  stripeInvoiceId: string
  stripeNumber: string | null
  stripeStatus: 'idempotent' | 'duplicate-in-myob' | 'ready' | 'blocked'
  blockedReason?: string

  gross_cents: number          // Stripe gross (= invoice total)
  fee_cents: number            // Stripe fee from balance_transaction.fee
  net_cents: number            // gross - fee
  feeResolution: string        // note describing how we found the fee (or didn't)

  customer: {
    decision: 'reuse' | 'create' | 'ambiguous' | 'error'
    myobUid?: string
    myobDisplayId?: string
    myobName?: string
    candidates?: Array<{ uid: string; name: string; displayId: string }>
    note?: string
    stripeEmail: string | null
    stripeName: string | null
  }

  // The exact MYOB payloads we'd POST.
  invoicePayload: any
  paymentPayload: any | null   // null if customer can't be resolved
}

export interface PushOptions {
  dryRun: boolean              // true → don't write, just return preview
  performedBy?: string | null  // user email for audit
  // Optional per-call overrides (used by the UI to disambiguate)
  customerOverrideUid?: string  // force this MYOB customer UID
  saleAccountUid?: string       // override the sale revenue account
}

// ── MYOB customer match ─────────────────────────────────────────────────

function escapeOData(s: string): string {
  return s.replace(/'/g, "''")
}

async function searchJawsCustomersByName(
  connId: string,
  cfId: string,
  name: string,
  limit = 10,
): Promise<Array<{ uid: string; displayId: string; name: string }>> {
  if (!name.trim()) return []
  const tokens = name.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3)
  const tokenClauses = tokens.map(t => {
    const safe = escapeOData(t)
    return `(substringof('${safe}',tolower(CompanyName)) or ` +
           `substringof('${safe}',tolower(LastName)) or ` +
           `substringof('${safe}',tolower(FirstName)))`
  })
  const filter = `IsActive eq true and ` + tokenClauses.join(' and ')
  const { data } = await myobFetch(connId, `/accountright/${cfId}/Contact/Customer`, {
    query: { '$top': limit, '$orderby': 'CompanyName', '$filter': filter },
  })
  const items: any[] = Array.isArray(data?.Items) ? data.Items : []
  return items.map(c => ({
    uid: c.UID,
    displayId: c.DisplayID || '',
    name: (c.CompanyName || `${c.FirstName || ''} ${c.LastName || ''}`).trim() || '(unnamed)',
  }))
}

async function createJawsCustomer(
  connId: string,
  cfId: string,
  name: string,
  email: string | null,
): Promise<{ uid: string; displayId: string; name: string }> {
  // Decide CompanyName vs FirstName/LastName.
  // If the name has a space and no obvious business words, treat as person.
  const trimmed = (name || '').trim()
  const looksLikePerson = /^[A-Z][a-z]+(?:\s+[A-Z][a-z\-']+){1,3}$/.test(trimmed)

  const body: any = {
    IsIndividual: looksLikePerson,
    IsActive: true,
    // MYOB requires SellingDetails on customer create — defaults match
    // the JAWS Professional invoice flow.
    SellingDetails: {
      SaleLayout: 'Professional',
      TaxCode:        { UID: JAWS_UIDS.TAX_CODE_GST },
      FreightTaxCode: { UID: JAWS_UIDS.TAX_CODE_GST },
      IsTaxInclusive: true,
    },
  }
  if (looksLikePerson) {
    const parts = trimmed.split(/\s+/)
    body.FirstName = parts.slice(0, parts.length - 1).join(' ')
    body.LastName  = parts[parts.length - 1]
  } else {
    body.CompanyName = trimmed || 'Stripe Customer'
  }
  if (email) {
    body.Addresses = [{ Location: 1, Email: email }]
  }

  const res = await myobFetch(connId, `/accountright/${cfId}/Contact/Customer`, {
    method: 'POST', body, query: { returnBody: 'true' },
  })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`MYOB customer create failed: HTTP ${res.status} ${res.raw?.slice(0, 200)}`)
  }
  const created = res.data
  return {
    uid: created.UID,
    displayId: created.DisplayID || '',
    name: trimmed,
  }
}

// ── Idempotency: search MYOB JournalMemo for the Stripe id ─────────────
// Make's JournalMemo format is "Platinu Parters Stripe Invoice #ii_xxx" or
// "Platinu Parters Stripe Invoice #in_xxx". We do a substring match on
// the Stripe id portion — that's reliable across either prefix variant.

// Search MYOB for any Sale.Invoice/Professional whose JournalMemo contains
// any of the supplied Stripe ids. This catches duplicates created by Make
// (which used the invoice-item id `ii_xxx`) as well as anything created by
// this tool (which uses the invoice id `in_xxx`). Pass the invoice id PLUS
// every line's id and invoice_item id for max coverage.
// Exposed for the sync endpoint — same function, different caller.
export async function findMyobMatchForStripeIds(
  connId: string,
  cfId: string,
  stripeIds: string[],
): Promise<{ uid: string; number: string; matchedStripeId: string } | null> {
  return findExistingMyobInvoiceByAnyStripeId(connId, cfId, stripeIds)
}

// Fuzzy fallback: find a MYOB Sale/Invoice/Professional where the
// customer-name search hits AND the total amount equals (in dollars,
// tolerance 1c) AND the invoice date is within ±dayWindow of the
// Stripe paid date. Used by the sync endpoint when the id-substring
// search misses (typically older Make-created records).
//
// Returns null if zero matches OR more than one match (we never
// auto-resolve ambiguity — a human picks via the preview modal).
export async function findMyobMatchByCustomerAmountDate(
  connId: string,
  cfId: string,
  args: {
    customerName: string
    grossDollars: number
    isoDate: string         // yyyy-mm-dd — Stripe paid date
    dayWindow?: number      // default ±3
  },
): Promise<{ uid: string; number: string; reason: string } | null> {
  const dayWindow = args.dayWindow ?? 3
  if (!args.customerName.trim() || !isFinite(args.grossDollars) || args.grossDollars <= 0) return null

  // 1. Find candidate MYOB customers by name (same logic as push).
  const customers = await searchJawsCustomersByName(connId, cfId, args.customerName, 5)
  if (customers.length === 0) return null

  // 2. Build a date range filter (±dayWindow days).
  const baseMs = Date.parse(args.isoDate + 'T00:00:00Z')
  if (!isFinite(baseMs)) return null
  const fromIso = new Date(baseMs - dayWindow * 86400_000).toISOString().slice(0, 10) + 'T00:00:00'
  const toIso   = new Date(baseMs + dayWindow * 86400_000).toISOString().slice(0, 10) + 'T23:59:59'

  // 3. For each candidate customer, pull their invoices in the window
  //    and check totals. (MYOB OData doesn't reliably support nested
  //    Customer/UID navigation in $filter — keep it simple.)
  const hits: Array<{ uid: string; number: string; reason: string }> = []
  for (const cust of customers) {
    const filter = `Customer/UID eq guid'${cust.uid}' and Date ge datetime'${fromIso}' and Date le datetime'${toIso}'`
    const { status, data } = await myobFetch(connId, `/accountright/${cfId}/Sale/Invoice/Professional`, {
      query: { '$top': 20, '$filter': filter },
    })
    if (status !== 200) continue
    const items: any[] = Array.isArray(data?.Items) ? data.Items : []
    for (const inv of items) {
      const total = typeof inv.TotalAmount === 'number' ? inv.TotalAmount : parseFloat(inv.TotalAmount || '0')
      if (Math.abs(total - args.grossDollars) < 0.01) {
        hits.push({
          uid: inv.UID,
          number: inv.Number || '',
          reason: `${cust.name} · $${total.toFixed(2)} · ${String(inv.Date).slice(0, 10)}`,
        })
      }
    }
  }
  if (hits.length === 1) return hits[0]
  return null  // zero or ambiguous → don't auto-match
}

async function findExistingMyobInvoiceByAnyStripeId(
  connId: string,
  cfId: string,
  stripeIds: string[],
): Promise<{ uid: string; number: string; matchedStripeId: string } | null> {
  const unique = Array.from(new Set(stripeIds.filter(Boolean)))
  if (unique.length === 0) return null

  // OR-chained substringof — MYOB caps URL length so batch in groups of 8
  // (each clause is ~50 chars; 8 fits well under typical 2KB query limit).
  for (let i = 0; i < unique.length; i += 8) {
    const batch = unique.slice(i, i + 8)
    const clauses = batch.map(id => `substringof('${escapeOData(id)}',JournalMemo)`)
    const filter = clauses.join(' or ')
    const { data } = await myobFetch(connId, `/accountright/${cfId}/Sale/Invoice/Professional`, {
      query: { '$top': 1, '$filter': filter },
    })
    const items: any[] = Array.isArray(data?.Items) ? data.Items : []
    if (items.length > 0) {
      // Figure out which of our ids matched, for the audit note.
      const memo: string = String(items[0].JournalMemo || '')
      const matched = batch.find(id => memo.includes(id)) || batch[0]
      return { uid: items[0].UID, number: items[0].Number || '', matchedStripeId: matched }
    }
  }
  return null
}

// ── Stripe: get the fee for an invoice via its charge → balance_txn ───

async function getStripeInvoiceFee(
  account: StripeAccountLabel,
  invoice: StripeInvoiceLite,
): Promise<{ fee_cents: number; balance_transaction_id: string | null; charge_id: string | null; note: string }> {
  // Find a charge id via multiple fallbacks — Stripe API version drift
  // means different fields are populated on different accounts.
  let chargeId: string | null = invoice.charge
  let path = 'invoice.charge'

  if (!chargeId && invoice.payment_intent) {
    try {
      const pi = await retrievePaymentIntent(account, invoice.payment_intent)
      chargeId = pi.latest_charge || null
      path = 'payment_intent.latest_charge'
    } catch { /* fall through */ }
  }

  // Last-resort: re-fetch the invoice directly (single-retrieve returns
  // fields the list endpoint strips) and re-check both.
  if (!chargeId) {
    try {
      const full = await retrieveInvoice(account, invoice.id)
      chargeId = full.charge || null
      if (!chargeId && full.payment_intent) {
        const pi = await retrievePaymentIntent(account, full.payment_intent)
        chargeId = pi.latest_charge || null
        path = 'retrieve-invoice → payment_intent.latest_charge'
      } else if (chargeId) {
        path = 'retrieve-invoice → charge'
      }
    } catch { /* fall through */ }
  }

  // Last-last-resort: list charges filtered by invoice id.
  if (!chargeId) {
    try {
      const charges = await listChargesForInvoice(account, invoice.id)
      const succeeded = charges.find(c => c.status === 'succeeded') || charges[0]
      if (succeeded) {
        chargeId = succeeded.id
        path = 'list-charges?invoice='
      }
    } catch { /* fall through */ }
  }

  if (!chargeId) {
    return { fee_cents: 0, balance_transaction_id: null, charge_id: null, note: 'no charge findable via any path — assuming zero fee' }
  }

  // Fetch charge → balance_transaction id
  const charge = await retrieveCharge(account, chargeId)
  if (!charge.balance_transaction) {
    return { fee_cents: 0, balance_transaction_id: null, charge_id: chargeId, note: `charge ${chargeId} has no balance_transaction yet (via ${path})` }
  }

  // Fetch balance_transaction → fee
  const bt: StripeBalanceTxLite = await retrieveBalanceTransaction(account, charge.balance_transaction)
  return { fee_cents: bt.fee || 0, balance_transaction_id: bt.id, charge_id: chargeId, note: `fee resolved via ${path}` }
}

// ── Payload builders ────────────────────────────────────────────────────

function buildInvoicePayload(params: {
  customerUid: string
  gross_cents: number
  fee_cents: number
  saleAccountUid: string
  description: string
  stripeInvoiceId: string
  invoiceDate: string  // ISO yyyy-mm-dd
}): any {
  // MYOB amounts are floats (dollars). IsTaxInclusive=true matches what
  // Make creates today, so unit prices on the Stripe invoice (which are
  // already GST-inclusive) flow through unchanged.
  const grossDollars = params.gross_cents / 100
  const feeDollars   = params.fee_cents / 100

  const lines: any[] = [
    {
      Type: 'Transaction',
      Description: params.description,
      Total: grossDollars,
      Account: { UID: params.saleAccountUid },
      TaxCode: { UID: JAWS_UIDS.TAX_CODE_GST },
    },
  ]
  if (feeDollars > 0) {
    lines.push({
      Type: 'Transaction',
      Description: 'Stripe Fee',
      Total: -feeDollars,
      Account: { UID: JAWS_UIDS.ACCT_STRIPE_FEE },
      TaxCode: { UID: JAWS_UIDS.TAX_CODE_GST },
    })
  }

  return {
    Date: params.invoiceDate + 'T00:00:00',
    Customer: { UID: params.customerUid },
    Lines: lines,
    IsTaxInclusive: true,
    Comment: 'Invoice from Stripe',
    JournalMemo: `Platinum Parters Stripe Invoice #${params.stripeInvoiceId}`,
    Terms: {
      PaymentIsDue: 'DayOfMonthAfterEOM',
      DiscountDate: 1,
      BalanceDueDate: 30,
    },
  }
}

function buildPaymentPayload(params: {
  customerUid: string
  invoiceUid: string
  net_cents: number
  stripeInvoiceId: string
  paymentDate: string  // ISO yyyy-mm-dd
}): any {
  const netDollars = params.net_cents / 100
  return {
    Date: params.paymentDate + 'T00:00:00',
    Customer: { UID: params.customerUid },
    DepositTo: 'UndepositedFunds',
    Account: { UID: JAWS_UIDS.ACCT_UNDEP_FUNDS },
    PaymentMethod: 'Visa',
    AmountReceived: netDollars,
    Memo: `Platinum Parters Stripe Invoice #${params.stripeInvoiceId}`,
    Invoices: [
      { UID: params.invoiceUid, AmountApplied: netDollars, Type: 'Invoice' },
    ],
  }
}

// ── Main: preview / push a single Stripe invoice ────────────────────────

export interface PushResult extends PushPreview {
  pushed: boolean
  pushedAt?: string
  myobInvoiceUid?: string
  myobInvoiceNumber?: string
  myobPaymentUid?: string
  error?: string
}

export async function pushStripeInvoiceToJaws(
  account: StripeAccountLabel,
  invoice: StripeInvoiceLite,
  options: PushOptions,
): Promise<PushResult> {
  const conn = await getConnection('JAWS')
  if (!conn) throw new Error('No JAWS MYOB connection')
  if (!conn.company_file_id) throw new Error('JAWS connection has no company file selected')
  const cfId = conn.company_file_id

  // 1. Sync-log idempotency
  const existing = await sb()
    .from('stripe_myob_sync_log')
    .select('*')
    .eq('stripe_account', account)
    .eq('stripe_entity_type', 'invoice')
    .eq('stripe_entity_id', invoice.id)
    .maybeSingle()

  if (existing.data?.status === 'pushed') {
    return {
      stripeInvoiceId: invoice.id,
      stripeNumber: invoice.number,
      stripeStatus: 'idempotent',
      gross_cents: invoice.total,
      fee_cents: existing.data.fee_cents || 0,
      net_cents:  existing.data.net_cents  || invoice.total,
      feeResolution: 'cached from previous push',
      customer: {
        decision: 'reuse',
        myobUid: existing.data.myob_customer_uid || undefined,
        stripeEmail: invoice.customer_email,
        stripeName: invoice.customer_name,
      },
      invoicePayload: null,
      paymentPayload: null,
      pushed: false,
      myobInvoiceUid: existing.data.myob_invoice_uid || undefined,
      myobPaymentUid: existing.data.myob_payment_uid || undefined,
    }
  }

  // 2. Defence-in-depth: check MYOB for an invoice whose JournalMemo
  //    contains the invoice id OR any of its line ids / underlying
  //    invoice-item ids. The broader search catches Make-created records
  //    (which used ii_xxx) as well as anything we may have written before.
  const stripeIdsToCheck: string[] = [invoice.id]
  for (const ln of (invoice.lines?.data || [])) {
    if (ln.id) stripeIdsToCheck.push(ln.id)
    if (ln.invoice_item) stripeIdsToCheck.push(ln.invoice_item)
  }
  const duplicate = await findExistingMyobInvoiceByAnyStripeId(conn.id, cfId, stripeIdsToCheck)
  if (duplicate) {
    // Record it as skipped_duplicate so the UI shows it correctly.
    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'invoice',
      stripe_entity_id: invoice.id,
      myob_company_file: 'JAWS',
      myob_invoice_uid: duplicate.uid,
      status: 'skipped_duplicate',
      amount_cents: invoice.total,
      customer_email: invoice.customer_email,
      customer_name: invoice.customer_name,
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })
    return {
      stripeInvoiceId: invoice.id,
      stripeNumber: invoice.number,
      stripeStatus: 'duplicate-in-myob',
      gross_cents: invoice.total,
      fee_cents: 0,
      net_cents: invoice.total,
      feeResolution: 'not needed — duplicate already in MYOB',
      customer: {
        decision: 'reuse',
        note: `Found existing MYOB invoice ${duplicate.number} (JournalMemo contains ${duplicate.matchedStripeId})`,
        stripeEmail: invoice.customer_email,
        stripeName: invoice.customer_name,
      },
      invoicePayload: null,
      paymentPayload: null,
      pushed: false,
      myobInvoiceUid: duplicate.uid,
      myobInvoiceNumber: duplicate.number,
    }
  }

  // 3. Resolve fee
  const feeInfo = await getStripeInvoiceFee(account, invoice)
  const fee_cents = feeInfo.fee_cents
  const gross_cents = invoice.total
  const net_cents = gross_cents - fee_cents

  // 4. Resolve customer
  let customer: PushPreview['customer']
  if (options.customerOverrideUid) {
    customer = {
      decision: 'reuse',
      myobUid: options.customerOverrideUid,
      stripeEmail: invoice.customer_email,
      stripeName: invoice.customer_name,
      note: 'override supplied by caller',
    }
  } else {
    const candidates = await searchJawsCustomersByName(
      conn.id, cfId, invoice.customer_name || '', 5
    )
    if (candidates.length === 1) {
      customer = {
        decision: 'reuse',
        myobUid: candidates[0].uid,
        myobDisplayId: candidates[0].displayId,
        myobName: candidates[0].name,
        stripeEmail: invoice.customer_email,
        stripeName: invoice.customer_name,
      }
    } else if (candidates.length === 0) {
      if (options.dryRun) {
        // Preview: synthesise a "would-create" customer entry without writing
        customer = {
          decision: 'create',
          stripeEmail: invoice.customer_email,
          stripeName: invoice.customer_name,
          note: `Will create new MYOB customer "${invoice.customer_name || invoice.customer_email || 'Stripe Customer'}"`,
        }
      } else {
        const created = await createJawsCustomer(
          conn.id, cfId,
          invoice.customer_name || invoice.customer_email || 'Stripe Customer',
          invoice.customer_email,
        )
        customer = {
          decision: 'create',
          myobUid: created.uid,
          myobDisplayId: created.displayId,
          myobName: created.name,
          stripeEmail: invoice.customer_email,
          stripeName: invoice.customer_name,
          note: 'Created new MYOB customer card',
        }
      }
    } else {
      customer = {
        decision: 'ambiguous',
        candidates,
        stripeEmail: invoice.customer_email,
        stripeName: invoice.customer_name,
        note: `${candidates.length} possible matches — caller must pass customerOverrideUid to push`,
      }
    }
  }

  // 5. Build payloads
  const saleAccountUid = options.saleAccountUid || JAWS_UIDS.ACCT_TUNING_DEFAULT
  const description = (invoice.lines?.data?.[0]?.description || invoice.description || 'Stripe Sale').trim()
  const invoiceDate = new Date((invoice.status_transitions?.paid_at || invoice.created) * 1000)
    .toISOString().slice(0, 10)

  let invoicePayload: any = null
  let paymentPayload: any = null
  if (customer.decision !== 'ambiguous' && customer.decision !== 'error') {
    // For dry-run create-customer we don't have a uid yet — use a placeholder.
    const customerUidForPayload = customer.myobUid || '<<NEW_CUSTOMER_UID>>'
    invoicePayload = buildInvoicePayload({
      customerUid: customerUidForPayload,
      gross_cents,
      fee_cents,
      saleAccountUid,
      description,
      stripeInvoiceId: invoice.id,
      invoiceDate,
    })
    paymentPayload = buildPaymentPayload({
      customerUid: customerUidForPayload,
      invoiceUid: '<<NEW_INVOICE_UID>>',
      net_cents,
      stripeInvoiceId: invoice.id,
      paymentDate: invoiceDate,
    })
  }

  const stripeStatus: PushPreview['stripeStatus'] =
    customer.decision === 'ambiguous' ? 'blocked' : 'ready'
  const blockedReason = customer.decision === 'ambiguous' ? customer.note : undefined

  const preview: PushPreview = {
    stripeInvoiceId: invoice.id,
    stripeNumber: invoice.number,
    stripeStatus,
    blockedReason,
    gross_cents,
    fee_cents,
    net_cents,
    feeResolution: feeInfo.note,
    customer,
    invoicePayload,
    paymentPayload,
  }

  if (options.dryRun || stripeStatus === 'blocked') {
    // Record/refresh a pending row so the UI shows the preview history.
    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'invoice',
      stripe_entity_id: invoice.id,
      myob_company_file: 'JAWS',
      status: 'pending',
      amount_cents: gross_cents,
      fee_cents,
      net_cents,
      customer_email: invoice.customer_email,
      customer_name: invoice.customer_name,
      myob_customer_uid: customer.myobUid || null,
      raw_payload: { invoice, fee: feeInfo },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })
    return { ...preview, pushed: false }
  }

  // 6. Real push: invoice, then payment.
  try {
    const invRes = await myobFetch(conn.id, `/accountright/${cfId}/Sale/Invoice/Professional`, {
      method: 'POST',
      body: { ...invoicePayload, Customer: { UID: customer.myobUid } },
      query: { returnBody: 'true' },
    })
    if (invRes.status !== 200 && invRes.status !== 201) {
      throw new Error(`Sale.Invoice POST HTTP ${invRes.status}: ${invRes.raw?.slice(0, 300)}`)
    }
    const createdInvoice = invRes.data
    const invoiceUid = createdInvoice.UID

    const payRes = await myobFetch(conn.id, `/accountright/${cfId}/Sale/CustomerPayment`, {
      method: 'POST',
      body: {
        ...paymentPayload,
        Customer: { UID: customer.myobUid },
        Invoices: [{ UID: invoiceUid, AmountApplied: net_cents / 100, Type: 'Invoice' }],
      },
      query: { returnBody: 'true' },
    })
    if (payRes.status !== 200 && payRes.status !== 201) {
      throw new Error(`CustomerPayment POST HTTP ${payRes.status}: ${payRes.raw?.slice(0, 300)}`)
    }
    const createdPayment = payRes.data

    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'invoice',
      stripe_entity_id: invoice.id,
      myob_company_file: 'JAWS',
      myob_invoice_uid: invoiceUid,
      myob_payment_uid: createdPayment.UID,
      myob_customer_uid: customer.myobUid,
      status: 'pushed',
      amount_cents: gross_cents,
      fee_cents,
      net_cents,
      customer_email: invoice.customer_email,
      customer_name: invoice.customer_name,
      pushed_at: new Date().toISOString(),
      raw_payload: { invoice, fee: feeInfo, myobInvoice: createdInvoice, myobPayment: createdPayment },
      attempts: (existing.data?.attempts || 0) + 1,
      last_error: null,  // clear any prior failure message
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      ...preview,
      pushed: true,
      pushedAt: new Date().toISOString(),
      myobInvoiceUid: invoiceUid,
      myobInvoiceNumber: createdInvoice.Number,
      myobPaymentUid: createdPayment.UID,
    }
  } catch (e: any) {
    const errMsg = (e?.message || String(e)).slice(0, 500)
    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'invoice',
      stripe_entity_id: invoice.id,
      myob_company_file: 'JAWS',
      status: 'failed',
      amount_cents: gross_cents,
      fee_cents,
      net_cents,
      customer_email: invoice.customer_email,
      customer_name: invoice.customer_name,
      myob_customer_uid: customer.myobUid || null,
      last_error: errMsg,
      attempts: (existing.data?.attempts || 0) + 1,
      raw_payload: { invoice, fee: feeInfo, attemptedPayloads: { invoicePayload, paymentPayload } },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })
    return { ...preview, pushed: false, error: errMsg }
  }
}

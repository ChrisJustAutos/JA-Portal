// lib/stripe-multi.ts
//
// Multi-account Stripe client. The B2B portal uses lib/stripe.ts which
// reads STRIPE_SECRET_KEY (single account). For the JAWS Stripe→MYOB
// backfill + future backup tool we need to talk to *other* connected
// Stripe accounts — each with its own API key — without disturbing the
// existing portal flow.
//
// Required env vars (one per account label):
//   STRIPE_SECRET_KEY_JAWS_JMACX
//   STRIPE_SECRET_KEY_JAWS_ET
//
// To add more accounts, add another env var following the same suffix
// pattern and add the label to STRIPE_ACCOUNT_LABELS.

export const STRIPE_ACCOUNT_LABELS = ['JAWS_JMACX', 'JAWS_ET'] as const
export type StripeAccountLabel = typeof STRIPE_ACCOUNT_LABELS[number]

const STRIPE_API = 'https://api.stripe.com/v1'

function keyFor(label: StripeAccountLabel): string {
  const envName = `STRIPE_SECRET_KEY_${label}`
  const k = process.env[envName]
  if (!k) throw new Error(`${envName} not set`)
  return k
}

async function req(
  label: StripeAccountLabel,
  method: 'GET' | 'POST',
  path: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${keyFor(label)}`,
  }
  const res = await fetch(`${STRIPE_API}${path}`, { method, headers })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`
    throw new Error(`Stripe ${method} ${path} failed (${label}): ${msg}`)
  }
  return json
}

// ── Types — slim slices of the Stripe API we actually use ──────────────

export interface StripeListPage<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  url: string
}

export interface StripeCustomerLite {
  id: string             // cus_...
  email: string | null
  name: string | null
  phone: string | null
  description: string | null
  metadata: Record<string, string>
}

export interface StripeInvoiceLineLite {
  id: string             // il_... (invoice line) — current API
  invoice_item: string | null  // ii_... — the underlying InvoiceItem if any
  amount: number         // cents (gross)
  currency: string
  description: string | null
  quantity: number | null
  price: {
    id: string
    product: string
    nickname: string | null
    unit_amount: number | null
  } | null
}

export interface StripeInvoiceLite {
  id: string                       // in_...
  customer: string | null          // cus_... (or expanded object)
  customer_email: string | null    // populated when customer not expanded
  customer_name: string | null
  number: string | null            // Stripe-assigned readable number e.g. INV-0001
  status: string                   // 'paid' | 'open' | 'void' | 'uncollectible' | 'draft'
  paid: boolean
  amount_due: number               // cents
  amount_paid: number              // cents
  total: number                    // cents (gross — incl. tax)
  subtotal: number                 // cents
  tax: number | null
  currency: string
  created: number                  // unix seconds
  status_transitions: {
    paid_at: number | null
    finalized_at: number | null
    voided_at: number | null
  }
  lines: StripeListPage<StripeInvoiceLineLite>
  charge: string | null            // ch_... — set once paid
  payment_intent: string | null    // pi_...
  description: string | null
  metadata: Record<string, string>
}

export interface StripeChargeLite {
  id: string                       // ch_...
  amount: number                   // cents (gross)
  amount_captured: number
  amount_refunded: number
  currency: string
  status: string                   // 'succeeded' | 'pending' | 'failed'
  paid: boolean
  refunded: boolean
  customer: string | null
  payment_intent: string | null
  invoice: string | null
  balance_transaction: string | null
  description: string | null
  receipt_email: string | null
  metadata: Record<string, string>
  created: number
  billing_details: {
    name: string | null
    email: string | null
    phone: string | null
  }
}

export interface StripeBalanceTxLite {
  id: string                       // txn_...
  amount: number                   // cents (gross)
  fee: number                      // cents (Stripe fee, ALWAYS positive)
  net: number                      // cents (amount - fee)
  currency: string
  type: string                     // 'charge' | 'refund' | 'payout' | ...
  description: string | null
  source: string | null            // ch_..., re_..., pyo_...
  created: number
}

export interface StripeRefundLite {
  id: string                       // re_...
  amount: number                   // cents
  currency: string
  status: string                   // 'pending' | 'succeeded' | 'failed'
  reason: string | null
  charge: string | null
  payment_intent: string | null
  balance_transaction: string | null
  created: number
  metadata: Record<string, string>
}

export interface StripePayoutLite {
  id: string                       // pyout_... (or po_...)
  amount: number                   // cents — net to bank
  currency: string
  status: string                   // 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed'
  arrival_date: number             // unix seconds — when it lands
  created: number                  // unix seconds
  description: string | null
  destination: string | null       // ba_xxx
  method: string                   // 'standard' | 'instant'
  type: string                     // 'bank_account'
  balance_transaction: string | null   // txn_xxx for the payout itself (carries fee)
  failure_balance_transaction: string | null
  failure_code: string | null
  failure_message: string | null
  statement_descriptor: string | null
  metadata: Record<string, string>
}

// ── Listing helpers ─────────────────────────────────────────────────────
// Stripe paginates with `starting_after=<last_id>`, max 100 per page.

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    qs.append(k, String(v))
  }
  const str = qs.toString()
  return str ? `?${str}` : ''
}

async function listAll<T extends { id: string }>(
  label: StripeAccountLabel,
  path: string,
  params: Record<string, string | number | undefined>,
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = []
  let startingAfter: string | undefined = undefined
  for (let i = 0; i < maxPages; i++) {
    const page = await req(label, 'GET', path + buildQuery({
      ...params,
      limit: 100,
      starting_after: startingAfter,
    })) as StripeListPage<T>
    const items = Array.isArray(page?.data) ? page.data : []
    out.push(...items)
    if (!page.has_more || items.length === 0) break
    startingAfter = items[items.length - 1].id
  }
  return out
}

// ── Public list functions ───────────────────────────────────────────────

/** Paid invoices in a date range (created.gte/lte are unix seconds). */
export async function listPaidInvoices(
  label: StripeAccountLabel,
  sinceUnix: number,
  untilUnix: number,
): Promise<StripeInvoiceLite[]> {
  return listAll<StripeInvoiceLite>(label, '/invoices', {
    status: 'paid',
    'created[gte]': sinceUnix,
    'created[lte]': untilUnix,
  })
}

/** Successful charges in a date range. */
export async function listCharges(
  label: StripeAccountLabel,
  sinceUnix: number,
  untilUnix: number,
): Promise<StripeChargeLite[]> {
  return listAll<StripeChargeLite>(label, '/charges', {
    'created[gte]': sinceUnix,
    'created[lte]': untilUnix,
  })
}

/** Refunds in a date range. */
export async function listRefunds(
  label: StripeAccountLabel,
  sinceUnix: number,
  untilUnix: number,
): Promise<StripeRefundLite[]> {
  return listAll<StripeRefundLite>(label, '/refunds', {
    'created[gte]': sinceUnix,
    'created[lte]': untilUnix,
  })
}

/** Look up a single balance transaction by id (needed for fee details). */
export async function retrieveBalanceTransaction(
  label: StripeAccountLabel,
  txnId: string,
): Promise<StripeBalanceTxLite> {
  return req(label, 'GET', `/balance_transactions/${encodeURIComponent(txnId)}`)
}

/** Retrieve a single charge. */
export async function retrieveCharge(
  label: StripeAccountLabel,
  chargeId: string,
): Promise<StripeChargeLite> {
  return req(label, 'GET', `/charges/${encodeURIComponent(chargeId)}`)
}

/** Retrieve a single payment intent (used to find the latest_charge). */
export async function retrievePaymentIntent(
  label: StripeAccountLabel,
  piId: string,
): Promise<{ id: string; latest_charge: string | null; status: string }> {
  return req(label, 'GET', `/payment_intents/${encodeURIComponent(piId)}`)
}

/** Retrieve a single invoice (returns more fields than the list endpoint). */
export async function retrieveInvoice(
  label: StripeAccountLabel,
  invoiceId: string,
): Promise<StripeInvoiceLite> {
  return req(label, 'GET', `/invoices/${encodeURIComponent(invoiceId)}`)
}

/** List charges filtered by the invoice they belong to. Works across API versions. */
export async function listChargesForInvoice(
  label: StripeAccountLabel,
  invoiceId: string,
): Promise<StripeChargeLite[]> {
  const page = await req(label, 'GET', `/charges${buildQuery({ invoice: invoiceId, limit: 10 })}`) as StripeListPage<StripeChargeLite>
  return Array.isArray(page?.data) ? page.data : []
}

/** List payouts in a date range. arrival_date is when the deposit hits the bank. */
export async function listPayouts(
  label: StripeAccountLabel,
  sinceUnix: number,
  untilUnix: number,
): Promise<StripePayoutLite[]> {
  // Filter on arrival_date since that's the accounting date that matters.
  return listAll<StripePayoutLite>(label, '/payouts', {
    'arrival_date[gte]': sinceUnix,
    'arrival_date[lte]': untilUnix,
  })
}

/** Retrieve a single payout. */
export async function retrievePayout(
  label: StripeAccountLabel,
  payoutId: string,
): Promise<StripePayoutLite> {
  return req(label, 'GET', `/payouts/${encodeURIComponent(payoutId)}`)
}

/** List all balance transactions associated with a payout. */
export async function listBalanceTransactionsForPayout(
  label: StripeAccountLabel,
  payoutId: string,
): Promise<StripeBalanceTxLite[]> {
  const out: StripeBalanceTxLite[] = []
  let startingAfter: string | undefined = undefined
  for (let i = 0; i < 50; i++) {
    const page = await req(label, 'GET', `/balance_transactions${buildQuery({
      payout: payoutId,
      limit: 100,
      starting_after: startingAfter,
    })}`) as StripeListPage<StripeBalanceTxLite>
    const items = Array.isArray(page?.data) ? page.data : []
    out.push(...items)
    if (!page.has_more || items.length === 0) break
    startingAfter = items[items.length - 1].id
  }
  return out
}

/** Look up a Stripe customer. */
export async function retrieveCustomer(
  label: StripeAccountLabel,
  customerId: string,
): Promise<StripeCustomerLite> {
  return req(label, 'GET', `/customers/${encodeURIComponent(customerId)}`)
}

/** Quick sanity check — pings /account so we can verify the key works. */
export async function pingAccount(label: StripeAccountLabel): Promise<{ id: string; email: string | null; business_profile: any }> {
  return req(label, 'GET', '/account')
}

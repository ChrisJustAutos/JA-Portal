// lib/stripe-payout-sync.ts
//
// Reconcile a Stripe payout against MYOB JAWS.
//
// Per-charge fees are already on individual sale invoices (lines[1] =
// negative Stripe Fee), so per-charge fee accounting is a no-op here.
// What's left for the payout to handle:
//
//   1. Payout-level fee (Stripe's flat fee for the payout itself,
//      from the payout's balance_transaction.fee). Often $0 in AU but
//      sometimes non-zero. Booked as a Service.Invoice against the
//      "Stripe" customer with one negative line on 6-1350 Stripe Fee.
//
//   2. A Customer Payment of that negative invoice → Undeposited Funds.
//      This effectively reduces UF by the fee amount before deposit.
//
//   3. A Bank Transfer from Undeposited Funds → CHQ 1-1110 for the
//      actual amount Stripe deposited (payout.amount). This clears
//      the relevant chunk of UF and lands the money in the bank.
//
// Idempotency: stripe_myob_sync_log row with entity_type='payout',
// entity_id = payout.id. Replays return the existing row.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import {
  StripeAccountLabel,
  StripePayoutLite,
  StripeBalanceTxLite,
  retrievePayout,
  listBalanceTransactionsForPayout,
} from './stripe-multi'
import { JAWS_UIDS } from './stripe-myob-sync'

// ── Supabase ────────────────────────────────────────────────────────────
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

export interface PayoutBreakdown {
  payoutId: string
  status: string
  arrival_date_iso: string            // yyyy-mm-dd (Sydney-local)
  net_cents: number                   // payout.amount — what hit the bank
  payoutFee_cents: number             // fee charged on the payout itself
  chargeCount: number
  refundCount: number
  otherCount: number
  totalCharges_cents: number          // sum of charge gross (before per-charge fees)
  totalChargeFees_cents: number       // sum of per-charge fees (already on invoices)
  totalRefunds_cents: number
  balanceTxIds: string[]              // for the audit trail
}

export interface PayoutReconcilePreview {
  payoutId: string
  status: 'idempotent' | 'ready' | 'failed-fetch' | 'no-fee-zero-amount'
  breakdown: PayoutBreakdown | null
  // The MYOB entries we'd POST. All null if status != 'ready'.
  feeInvoicePayload: any | null       // negative Service Invoice for payout fee
  feePaymentPayload: any | null       // Customer Payment of the negative invoice → UF
  bankTransferPayload: any | null     // Banking/Transfer UF → CHQ
  // After-write fields (only present on real push):
  myobFeeInvoiceUid?: string
  myobFeeInvoiceNumber?: string
  myobFeePaymentUid?: string
  myobTransferUid?: string
  error?: string
}

// ── Stripe data extraction ──────────────────────────────────────────────

function ymdSydney(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

async function buildBreakdown(
  account: StripeAccountLabel,
  payoutId: string,
): Promise<PayoutBreakdown> {
  const [payout, txns] = await Promise.all([
    retrievePayout(account, payoutId),
    listBalanceTransactionsForPayout(account, payoutId),
  ])

  let chargeCount = 0, refundCount = 0, otherCount = 0
  let totalCharges = 0, totalChargeFees = 0, totalRefunds = 0
  const balanceTxIds: string[] = []

  for (const t of txns) {
    balanceTxIds.push(t.id)
    if (t.type === 'payout') {
      // The payout txn itself — its amount mirrors payout.amount as a
      // debit from the Stripe balance. Doesn't represent extra fees,
      // skip it.
      continue
    }
    if (t.type === 'charge' || t.type === 'payment') {
      chargeCount++
      totalCharges += t.amount || 0           // gross
      totalChargeFees += t.fee || 0           // per-charge fee (already on invoice)
    } else if (t.type === 'refund' || t.type === 'payment_refund') {
      refundCount++
      totalRefunds += Math.abs(t.amount || 0)
    } else {
      // Everything else (stripe_fee, tax_fee, application_fee, adjustment, ...)
      // is captured in the gap calculation below.
      otherCount++
    }
  }

  // Per-charge fees are already on individual sale invoices, so what
  // we expect to hit the bank from the matched charges is the gross
  // minus the per-charge fees minus refunds:
  const expected_net = totalCharges - totalChargeFees - totalRefunds
  // Any gap between expected and actual payout amount is the
  // payout-level fee (Stripe payout fee + GST on fees + adjustments).
  // Positive number = additional fees taken at payout time.
  const payoutFee = expected_net - payout.amount

  return {
    payoutId: payout.id,
    status: payout.status,
    arrival_date_iso: ymdSydney(payout.arrival_date || payout.created),
    net_cents: payout.amount,
    payoutFee_cents: payoutFee,
    chargeCount,
    refundCount,
    otherCount,
    totalCharges_cents: totalCharges,
    totalChargeFees_cents: totalChargeFees,
    totalRefunds_cents: totalRefunds,
    balanceTxIds,
  }
}

// ── MYOB payload builders ───────────────────────────────────────────────

function buildFeeInvoicePayload(args: {
  payoutId: string
  feeCents: number
  isoDate: string
}): any {
  const feeDollars = args.feeCents / 100
  return {
    Date: args.isoDate + 'T00:00:00',
    Customer: { UID: JAWS_UIDS.CUSTOMER_STRIPE },
    Lines: [{
      Type: 'Transaction',
      Description: `Stripe payout fee — ${args.payoutId}`,
      Total: -feeDollars,
      Account: { UID: JAWS_UIDS.ACCT_STRIPE_FEE },
      TaxCode: { UID: JAWS_UIDS.TAX_CODE_GST },
    }],
    IsTaxInclusive: true,
    Comment: 'Stripe payout fee',
    JournalMemo: `Stripe payout fee #${args.payoutId}`,
    Terms: { PaymentIsDue: 'DayOfMonthAfterEOM', DiscountDate: 1, BalanceDueDate: 30 },
  }
}

function buildFeePaymentPayload(args: {
  payoutId: string
  feeCents: number
  invoiceUid: string
  isoDate: string
}): any {
  const feeDollars = args.feeCents / 100
  return {
    Date: args.isoDate + 'T00:00:00',
    Customer: { UID: JAWS_UIDS.CUSTOMER_STRIPE },
    DepositTo: 'UndepositedFunds',
    Account: { UID: JAWS_UIDS.ACCT_UNDEP_FUNDS },
    PaymentMethod: 'Other',
    AmountReceived: -feeDollars,                  // settling a credit note
    Memo: `Stripe payout fee #${args.payoutId}`,
    Invoices: [{
      UID: args.invoiceUid,
      AmountApplied: -feeDollars,
      Type: 'Invoice',
    }],
  }
}

function buildBankTransferPayload(args: {
  payoutId: string
  netCents: number
  isoDate: string
}): any {
  // MYOB endpoint: /Banking/TransferMoneyTxn (NOT /Banking/Transfer —
  // that path returns a misleading 401 OAuthTokenIsInvalid).
  const netDollars = args.netCents / 100
  return {
    Date: args.isoDate + 'T00:00:00',
    FromAccount: { UID: JAWS_UIDS.ACCT_UNDEP_FUNDS },
    ToAccount:   { UID: JAWS_UIDS.ACCT_CHQ_3369 },
    Amount: netDollars,
    Memo: `Stripe payout deposit #${args.payoutId}`,
  }
}

// ── Main reconcile ──────────────────────────────────────────────────────

export interface ReconcileOptions {
  dryRun: boolean
  performedBy?: string | null
}

export async function reconcileStripePayoutToJaws(
  account: StripeAccountLabel,
  payoutId: string,
  options: ReconcileOptions,
): Promise<PayoutReconcilePreview> {
  // 1. Idempotency — sync log check
  const existing = await sb()
    .from('stripe_myob_sync_log')
    .select('*')
    .eq('stripe_account', account)
    .eq('stripe_entity_type', 'payout')
    .eq('stripe_entity_id', payoutId)
    .maybeSingle()

  if (existing.data?.status === 'pushed') {
    return {
      payoutId,
      status: 'idempotent',
      breakdown: null,
      feeInvoicePayload: null,
      feePaymentPayload: null,
      bankTransferPayload: null,
      myobTransferUid: existing.data.myob_invoice_uid || undefined,
    }
  }

  // 2. Pull Stripe data
  let breakdown: PayoutBreakdown
  try {
    breakdown = await buildBreakdown(account, payoutId)
  } catch (e: any) {
    return {
      payoutId, status: 'failed-fetch', breakdown: null,
      feeInvoicePayload: null, feePaymentPayload: null, bankTransferPayload: null,
      error: (e?.message || String(e)).slice(0, 300),
    }
  }

  // 3. Build payloads. If payoutFee is 0, skip the fee invoice/payment.
  const isoDate = breakdown.arrival_date_iso
  const feeInvoicePayload = breakdown.payoutFee_cents > 0
    ? buildFeeInvoicePayload({ payoutId, feeCents: breakdown.payoutFee_cents, isoDate })
    : null
  const feePaymentPayload = breakdown.payoutFee_cents > 0
    ? buildFeePaymentPayload({ payoutId, feeCents: breakdown.payoutFee_cents, invoiceUid: '<<NEW_FEE_INVOICE_UID>>', isoDate })
    : null
  const bankTransferPayload = buildBankTransferPayload({
    payoutId, netCents: breakdown.net_cents, isoDate,
  })

  if (options.dryRun) {
    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'payout',
      stripe_entity_id: payoutId,
      myob_company_file: 'JAWS',
      status: 'pending',
      amount_cents: breakdown.net_cents,
      fee_cents: breakdown.payoutFee_cents,
      net_cents: breakdown.net_cents,
      raw_payload: { breakdown },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      feeInvoicePayload,
      feePaymentPayload,
      bankTransferPayload,
    }
  }

  // 4. Real push — get the MYOB connection and POST.
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) throw new Error('No JAWS MYOB connection / company file')
  const cfId = conn.company_file_id

  // Resume from any partial state recorded on a prior failed attempt.
  // The raw_payload.partialResult is set in the catch block below
  // every time a step succeeds before a later step fails.
  const prevPartial: any = (existing.data?.raw_payload as any)?.partialResult || {}
  let myobFeeInvoiceUid: string | undefined = prevPartial.myobFeeInvoiceUid
  let myobFeeInvoiceNumber: string | undefined = prevPartial.myobFeeInvoiceNumber
  let myobFeePaymentUid: string | undefined = prevPartial.myobFeePaymentUid
  let myobTransferUid: string | undefined = prevPartial.myobTransferUid

  try {
    if (feeInvoicePayload && !myobFeeInvoiceUid) {
      const invRes = await myobFetch(conn.id, `/accountright/${cfId}/Sale/Invoice/Service`, {
        method: 'POST', body: feeInvoicePayload, query: { returnBody: 'true' },
      })
      if (invRes.status !== 200 && invRes.status !== 201) {
        throw new Error(`fee Sale.Invoice POST HTTP ${invRes.status}: ${invRes.raw?.slice(0, 300)}`)
      }
      myobFeeInvoiceUid = invRes.data?.UID
      myobFeeInvoiceNumber = invRes.data?.Number
    }

    if (feeInvoicePayload && myobFeeInvoiceUid && !myobFeePaymentUid) {
      const payRes = await myobFetch(conn.id, `/accountright/${cfId}/Sale/CustomerPayment`, {
        method: 'POST',
        body: {
          ...feePaymentPayload,
          Invoices: [{ UID: myobFeeInvoiceUid, AmountApplied: -(breakdown.payoutFee_cents / 100), Type: 'Invoice' }],
        },
        query: { returnBody: 'true' },
      })
      if (payRes.status !== 200 && payRes.status !== 201) {
        throw new Error(`fee CustomerPayment POST HTTP ${payRes.status}: ${payRes.raw?.slice(0, 300)}`)
      }
      myobFeePaymentUid = payRes.data?.UID
    }

    // Bank Transfer UF → CHQ for the actual deposited amount.
    if (!myobTransferUid) {
      const xferRes = await myobFetch(conn.id, `/accountright/${cfId}/Banking/TransferMoneyTxn`, {
        method: 'POST', body: bankTransferPayload, query: { returnBody: 'true' },
      })
      if (xferRes.status !== 200 && xferRes.status !== 201) {
        throw new Error(`Banking/TransferMoneyTxn POST HTTP ${xferRes.status}: ${xferRes.raw?.slice(0, 300)}`)
      }
      myobTransferUid = xferRes.data?.UID
    }

    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'payout',
      stripe_entity_id: payoutId,
      myob_company_file: 'JAWS',
      myob_invoice_uid: myobTransferUid || null,
      myob_payment_uid: myobFeePaymentUid || null,
      status: 'pushed',
      amount_cents: breakdown.net_cents,
      fee_cents: breakdown.payoutFee_cents,
      net_cents: breakdown.net_cents,
      pushed_at: new Date().toISOString(),
      raw_payload: {
        breakdown,
        myobFeeInvoiceUid, myobFeeInvoiceNumber, myobFeePaymentUid, myobTransferUid,
      },
      attempts: (existing.data?.attempts || 0) + 1,
      last_error: null,
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      feeInvoicePayload,
      feePaymentPayload,
      bankTransferPayload,
      myobFeeInvoiceUid,
      myobFeeInvoiceNumber,
      myobFeePaymentUid,
      myobTransferUid,
    }
  } catch (e: any) {
    const errMsg = (e?.message || String(e)).slice(0, 500)
    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'payout',
      stripe_entity_id: payoutId,
      myob_company_file: 'JAWS',
      status: 'failed',
      amount_cents: breakdown.net_cents,
      fee_cents: breakdown.payoutFee_cents,
      net_cents: breakdown.net_cents,
      last_error: errMsg,
      attempts: (existing.data?.attempts || 0) + 1,
      raw_payload: { breakdown, partialResult: { myobFeeInvoiceUid, myobFeePaymentUid, myobTransferUid } },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      feeInvoicePayload,
      feePaymentPayload,
      bankTransferPayload,
      myobFeeInvoiceUid,
      myobFeeInvoiceNumber,
      myobFeePaymentUid,
      myobTransferUid,
      error: errMsg,
    }
  }
}

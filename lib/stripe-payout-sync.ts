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
  retrieveCharge,
  listBalanceTransactionsForPayout,
} from './stripe-multi'
import { JAWS_UIDS } from './stripe-myob-sync'
import { postWebhook } from './slack'

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

export interface PayoutChargeDetail {
  stripeChargeId: string
  stripeInvoiceId: string | null
  myobReceiptNumber: string | null
  myobCustomerName: string | null
  netCents: number                   // what landed in UF for this charge
}

export interface PayoutReconcilePreview {
  payoutId: string
  status: 'idempotent' | 'ready' | 'failed-fetch' | 'no-fee-zero-amount'
  breakdown: PayoutBreakdown | null
  chargeDetails: PayoutChargeDetail[]
  // The MYOB entries we'd POST. All null if status != 'ready'.
  feeInvoicePayload: any | null       // negative Service Invoice for payout fee
  feePaymentPayload: any | null       // Customer Payment of the negative invoice → UF
  slackMessageText: string | null     // preview of what we'd post to slack
  // After-write fields (only present on real push):
  myobFeeInvoiceUid?: string
  myobFeeInvoiceNumber?: string
  myobFeePaymentUid?: string
  slackPosted?: boolean
  slackPostError?: string
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

// Enrich the payout breakdown with the matching MYOB customer-payment
// details for every charge in the payout — used to build the Slack
// message listing exactly which UF entries to tick when the user does
// "Prepare Bank Deposit" in MYOB UI.
//
// Match strategy: for each Stripe charge in the payout, search MYOB
// Sale/CustomerPayment for an entry whose AmountReceived matches the
// charge net (within 1c) and whose Date is within ±2 days of the
// charge date. Catches both our pushes AND Make-era records uniformly.
// Ambiguous matches (>1 hit) are left unmatched for human review.
async function getPayoutChargeDetails(
  account: StripeAccountLabel,
  txns: StripeBalanceTxLite[],
): Promise<PayoutChargeDetail[]> {
  const details: PayoutChargeDetail[] = []
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) return details
  const cfId = conn.company_file_id

  for (const t of txns) {
    if (t.type !== 'charge' && t.type !== 'payment') continue
    if (!t.source) continue

    const netCents = (t.amount || 0) - (t.fee || 0)
    const netDollars = netCents / 100
    const chargeDate = new Date((t.created || 0) * 1000)
    const fromIso = new Date(chargeDate.getTime() - 2 * 86400_000).toISOString().slice(0, 10) + 'T00:00:00'
    const toIso   = new Date(chargeDate.getTime() + 2 * 86400_000).toISOString().slice(0, 10) + 'T23:59:59'

    let myobReceiptNumber: string | null = null
    let myobCustomerName: string | null = null
    let stripeInvoiceId: string | null = null
    let stripeCustomerName: string | null = null

    // Resolve the Stripe customer name from the charge (used to
    // disambiguate when multiple MYOB payments match the date+amount).
    try {
      const charge = await retrieveCharge(account, t.source)
      stripeInvoiceId = charge.invoice || null
      stripeCustomerName = charge.billing_details?.name || null
    } catch { /* ignore */ }

    try {
      const { data } = await myobFetch(conn.id, `/accountright/${cfId}/Sale/CustomerPayment`, {
        query: {
          '$top': 50,
          '$filter': `Date ge datetime'${fromIso}' and Date le datetime'${toIso}'`,
        },
      })
      const items: any[] = Array.isArray(data?.Items) ? data.Items : []

      // Step 1: filter by amount (always required).
      const amountMatches = items.filter((p: any) => {
        const amt = typeof p.AmountReceived === 'number' ? p.AmountReceived : parseFloat(p.AmountReceived || '0')
        return Math.abs(amt - netDollars) < 0.01
      })

      // Step 2: if we have a Stripe customer name, narrow to that customer.
      let matches = amountMatches
      if (stripeCustomerName && amountMatches.length > 1) {
        const stripeTokens = stripeCustomerName.toLowerCase().split(/\s+/).filter(Boolean)
        matches = amountMatches.filter((p: any) => {
          const myobName: string = (p.Customer?.Name || '').toLowerCase()
          // Match if any token from the Stripe name appears in MYOB name
          return stripeTokens.some(tok => tok.length >= 3 && myobName.includes(tok))
        })
      }

      if (matches.length === 1) {
        const m = matches[0]
        myobReceiptNumber = m.ReceiptNumber || null
        myobCustomerName = m.Customer?.Name || null
      }
      // If matches.length > 1 or === 0, leave unmatched — human picks via Slack hint
    } catch { /* keep going */ }

    details.push({
      stripeChargeId: t.source,
      stripeInvoiceId,
      myobReceiptNumber,
      myobCustomerName,
      netCents,
    })
  }
  return details
}

function fmtMoneyCents(cents: number): string {
  const n = cents / 100
  const negative = n < 0
  const formatted = '$' + Math.abs(n).toLocaleString('en-AU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return negative ? '-' + formatted : formatted
}

function buildPayoutSlackMessage(args: {
  account: StripeAccountLabel
  payout: StripePayoutLite
  breakdown: PayoutBreakdown
  chargeDetails: PayoutChargeDetail[]
  feeInvoiceNumber: string | null
}): { text: string; blocks: any[] } {
  const accountLabel = args.account === 'JAWS_JMACX' ? 'JMACX' : 'ET'
  const dateStr = new Date(args.payout.arrival_date * 1000).toLocaleDateString('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'long', day: 'numeric', month: 'long',
  })
  const header = `${accountLabel} Stripe payout — ${fmtMoneyCents(args.breakdown.net_cents)} on ${dateStr}`

  const lines: string[] = []
  let listedTotal = 0
  let unmatched = 0
  for (const d of args.chargeDetails) {
    if (d.myobReceiptNumber) {
      lines.push(`• \`${d.myobReceiptNumber}\` · ${d.myobCustomerName || 'Customer'} · ${fmtMoneyCents(d.netCents)}`)
      listedTotal += d.netCents
    } else {
      lines.push(`• :grey_question: Stripe charge \`${d.stripeChargeId}\` · ${fmtMoneyCents(d.netCents)} _(not in MYOB sync log — may be a Make-era invoice)_`)
      unmatched++
    }
  }
  if (args.feeInvoiceNumber && args.breakdown.payoutFee_cents > 0) {
    lines.push(`• \`${args.feeInvoiceNumber}\` · Stripe (payout fee) · ${fmtMoneyCents(-args.breakdown.payoutFee_cents)}`)
    listedTotal += -args.breakdown.payoutFee_cents
  }

  const totalLine = `*Total:* ${fmtMoneyCents(listedTotal)}`
  const matchNote = listedTotal === args.breakdown.net_cents
    ? `:white_check_mark: Matches Stripe payout exactly`
    : `:warning: Stripe payout is ${fmtMoneyCents(args.breakdown.net_cents)} — gap of ${fmtMoneyCents(args.breakdown.net_cents - listedTotal)}`

  const blocks: any[] = [
    { type: 'header', text: { type: 'plain_text', text: header } },
    { type: 'section', text: { type: 'mrkdwn', text: `In MYOB JAWS → *Prepare Bank Deposit* → tick these Undeposited Funds entries and deposit to *CHQ 1-1110 (NAB Business Acc 3369)*:` } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') || '_no entries — nothing to deposit_' } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: `${totalLine}\n${matchNote}` } },
  ]
  if (unmatched > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:information_source: ${unmatched} charge${unmatched === 1 ? ' is' : 's are'} not in our sync log. Likely Make-era invoices in MYOB — find them by date/customer/amount and include in the deposit anyway.` } })
  }

  return {
    text: `${header} — ${args.chargeDetails.length} charges to deposit`,
    blocks,
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
      chargeDetails: [],
      feeInvoicePayload: null,
      feePaymentPayload: null,
      slackMessageText: null,
    }
  }

  // 2. Pull Stripe data
  let breakdown: PayoutBreakdown
  let txns: StripeBalanceTxLite[]
  let payoutObj: StripePayoutLite
  try {
    payoutObj = await retrievePayout(account, payoutId)
    txns = await listBalanceTransactionsForPayout(account, payoutId)
    // Rebuild breakdown locally to avoid a duplicate retrieve
    let chargeCount = 0, refundCount = 0, otherCount = 0
    let totalCharges = 0, totalChargeFees = 0, totalRefunds = 0
    const balanceTxIds: string[] = []
    for (const t of txns) {
      balanceTxIds.push(t.id)
      if (t.type === 'payout') continue
      if (t.type === 'charge' || t.type === 'payment') {
        chargeCount++; totalCharges += t.amount || 0; totalChargeFees += t.fee || 0
      } else if (t.type === 'refund' || t.type === 'payment_refund') {
        refundCount++; totalRefunds += Math.abs(t.amount || 0)
      } else {
        otherCount++
      }
    }
    const expected_net = totalCharges - totalChargeFees - totalRefunds
    breakdown = {
      payoutId: payoutObj.id,
      status: payoutObj.status,
      arrival_date_iso: ymdSydney(payoutObj.arrival_date || payoutObj.created),
      net_cents: payoutObj.amount,
      payoutFee_cents: expected_net - payoutObj.amount,
      chargeCount, refundCount, otherCount,
      totalCharges_cents: totalCharges,
      totalChargeFees_cents: totalChargeFees,
      totalRefunds_cents: totalRefunds,
      balanceTxIds,
    }
  } catch (e: any) {
    return {
      payoutId, status: 'failed-fetch', breakdown: null,
      chargeDetails: [],
      feeInvoicePayload: null, feePaymentPayload: null, slackMessageText: null,
      error: (e?.message || String(e)).slice(0, 300),
    }
  }

  // 3. Build the itemised charge details (for the Slack message)
  const chargeDetails = await getPayoutChargeDetails(account, txns)

  // 4. Build payloads. If payoutFee is 0, skip the fee invoice/payment.
  const isoDate = breakdown.arrival_date_iso
  const feeInvoicePayload = breakdown.payoutFee_cents > 0
    ? buildFeeInvoicePayload({ payoutId, feeCents: breakdown.payoutFee_cents, isoDate })
    : null
  const feePaymentPayload = breakdown.payoutFee_cents > 0
    ? buildFeePaymentPayload({ payoutId, feeCents: breakdown.payoutFee_cents, invoiceUid: '<<NEW_FEE_INVOICE_UID>>', isoDate })
    : null

  // Preview the Slack message (without the actual fee invoice number — will be filled in on real push)
  const previewSlack = buildPayoutSlackMessage({
    account,
    payout: payoutObj,
    breakdown,
    chargeDetails,
    feeInvoiceNumber: feeInvoicePayload ? '(will be assigned on push)' : null,
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
      raw_payload: { breakdown, chargeDetailsCount: chargeDetails.length },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      chargeDetails,
      feeInvoicePayload,
      feePaymentPayload,
      slackMessageText: previewSlack.text,
    }
  }

  // 5. Real push — get the MYOB connection and POST.
  const conn = await getConnection('JAWS')
  if (!conn?.company_file_id) throw new Error('No JAWS MYOB connection / company file')
  const cfId = conn.company_file_id

  // Resume from any partial state recorded on a prior failed attempt.
  const prevPartial: any = (existing.data?.raw_payload as any)?.partialResult || {}
  let myobFeeInvoiceUid: string | undefined = prevPartial.myobFeeInvoiceUid
  let myobFeeInvoiceNumber: string | undefined = prevPartial.myobFeeInvoiceNumber
  let myobFeePaymentUid: string | undefined = prevPartial.myobFeePaymentUid
  let slackPosted: boolean | undefined = prevPartial.slackPosted
  let slackPostError: string | undefined

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

    // Slack notification with itemised list for manual Prepare Bank Deposit
    if (!slackPosted) {
      const webhookUrl = process.env.SLACK_WEBHOOK_JAWS_PAYOUTS
        || process.env.SLACK_WEBHOOK_JAWS_PAYMENTS
      if (webhookUrl) {
        const finalSlack = buildPayoutSlackMessage({
          account,
          payout: payoutObj,
          breakdown,
          chargeDetails,
          feeInvoiceNumber: myobFeeInvoiceNumber || null,
        })
        try {
          const r = await postWebhook(webhookUrl, finalSlack)
          slackPosted = r.ok
          if (!r.ok) slackPostError = `Slack HTTP ${r.status}: ${r.body}`
        } catch (e: any) {
          slackPostError = (e?.message || String(e)).slice(0, 300)
        }
      } else {
        slackPostError = 'No SLACK_WEBHOOK_JAWS_PAYOUTS or SLACK_WEBHOOK_JAWS_PAYMENTS env var set'
      }
    }

    await sb().from('stripe_myob_sync_log').upsert({
      stripe_account: account,
      stripe_entity_type: 'payout',
      stripe_entity_id: payoutId,
      myob_company_file: 'JAWS',
      myob_invoice_uid: myobFeeInvoiceUid || null,
      myob_payment_uid: myobFeePaymentUid || null,
      status: 'pushed',
      amount_cents: breakdown.net_cents,
      fee_cents: breakdown.payoutFee_cents,
      net_cents: breakdown.net_cents,
      pushed_at: new Date().toISOString(),
      raw_payload: {
        breakdown,
        chargeDetails,
        myobFeeInvoiceUid, myobFeeInvoiceNumber, myobFeePaymentUid,
        slackPosted, slackPostError,
      },
      attempts: (existing.data?.attempts || 0) + 1,
      last_error: slackPostError || null,
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      chargeDetails,
      feeInvoicePayload,
      feePaymentPayload,
      slackMessageText: previewSlack.text,
      myobFeeInvoiceUid,
      myobFeeInvoiceNumber,
      myobFeePaymentUid,
      slackPosted,
      slackPostError,
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
      raw_payload: { breakdown, partialResult: { myobFeeInvoiceUid, myobFeeInvoiceNumber, myobFeePaymentUid, slackPosted } },
      created_by: options.performedBy || 'system',
    }, { onConflict: 'stripe_account,stripe_entity_type,stripe_entity_id' })

    return {
      payoutId,
      status: 'ready',
      breakdown,
      chargeDetails,
      feeInvoicePayload,
      feePaymentPayload,
      slackMessageText: previewSlack.text,
      myobFeeInvoiceUid,
      myobFeeInvoiceNumber,
      myobFeePaymentUid,
      error: errMsg,
    }
  }
}

// lib/ap-payment.ts
// Apply a Purchase Payment to a freshly-posted MYOB Service Bill so the
// bill is settled immediately against a clearing/liability account
// (e.g. Capricorn 2-1120) instead of sitting on the AP ledger.
//
// Used by createServiceBill (lib/ap-myob-bill.ts) when the AP invoice
// has payment_account_uid set. The payment is best-effort: a successful
// bill that fails to apply payment is still considered posted; the
// myob_payment_error column captures the failure for follow-up.
//
// MYOB endpoint:
//   POST /accountright/{cf_id}/Purchase/SupplierPayment
//
//   {
//     "Date":     "YYYY-MM-DD",            // payment date — bill date
//     "Account":  { "UID": "<from-account>" },  // e.g. Capricorn 2-1120
//     "Supplier": { "UID": "<supplier>" },
//     "Memo":     "<short>",
//     "Amount":   <number>,                // total payment amount
//     "Lines":    [ { "Type": "Bill", "UID": "<bill>", "AmountApplied": <number> } ]
//   }
//
// Returns 201 with a Location header containing the new payment UID.
//
// Note: an earlier draft used /Purchase/PaymentTxn and a {Bill:{UID}} line
// shape — both were wrong. MYOB returned 401 OAuthTokenIsInvalid (31001)
// for the bad path (it returns that error for any unknown path under the
// authenticated namespace, not just genuine token failures).

import { myobFetch } from './myob'

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface ApplyBillPaymentInput {
  connId: string
  cfId: string
  date: string                  // YYYY-MM-DD
  fromAccountUid: string        // payment_account_uid (the "from" side)
  supplierUid: string
  billUid: string
  amount: number                // total to apply (typically total_inc_gst)
  memo: string
  performedBy?: string | null
}

export interface ApplyBillPaymentResult {
  ok: true
  paymentUid: string
}

export async function applyBillPayment(input: ApplyBillPaymentInput): Promise<ApplyBillPaymentResult> {
  if (!input.fromAccountUid) throw new Error('fromAccountUid is required')
  if (!input.supplierUid)    throw new Error('supplierUid is required')
  if (!input.billUid)        throw new Error('billUid is required')
  if (!input.date)           throw new Error('date is required')
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(`amount must be a positive number (got ${input.amount})`)
  }

  const body = {
    Date:     input.date,
    Account:  { UID: input.fromAccountUid },
    Supplier: { UID: input.supplierUid },
    Memo:     (input.memo || '').substring(0, 255),
    Amount:   input.amount,
    Lines: [
      { Type: 'Bill', UID: input.billUid, AmountApplied: input.amount },
    ],
  }

  const path = `/accountright/${input.cfId}/Purchase/SupplierPayment`
  const result = await myobFetch(input.connId, path, {
    method: 'POST',
    body,
    performedBy: input.performedBy ?? null,
  })

  if (result.status >= 400) {
    const detail = result.data?.Errors?.[0]?.Message
                || result.data?.Errors?.[0]?.AdditionalDetails
                || (result.raw || '').substring(0, 300)
    throw new Error(`MYOB rejected the payment (HTTP ${result.status}): ${detail}`)
  }

  // UID lives in the Location header. Same trick as bill UID extraction —
  // URL contains TWO UUIDs (cfId + payment UID); take the LAST one and
  // refuse to return cfId by mistake.
  const location = result.headers?.['location'] || ''
  const uids = location.match(UUID_REGEX) || []
  const last = uids[uids.length - 1]
  if (!last || last.toLowerCase() === input.cfId.toLowerCase()) {
    throw new Error(`MYOB returned no payment UID (Location="${location}")`)
  }
  return { ok: true, paymentUid: last }
}

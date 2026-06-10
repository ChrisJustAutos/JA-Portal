// lib/workshop-credit-note.ts
//
// Credit notes / refunds for the workshop (VPS). LOCAL-FIRST: the credit note
// always records in workshop_credit_notes (it must work for imported MD
// invoices and while myob_posting_enabled is off); the MYOB push is
// best-effort on top and any failure lands in myob_write_error.
//
// MYOB shape mirrors the proven b2b pattern (lib/b2b-myob-invoice.ts::
// writeRefundCreditNoteToMyob): a credit note = NEGATIVE /Sale/Invoice —
// never an Order, credits must hit GL. Item layout when a Labour item is
// configured (negative ShipQuantity + positive UnitPrice; restocks parts),
// otherwise Service layout with negative account-line totals against the
// configured refund account.
//
// Refund money-out = a NEGATIVE workshop_payments row (kind='refund') to the
// tender's deposit account, so every existing paid/balance sum nets off for
// free. The MYOB Sale/CreditRefund leg is attempted when posting is enabled;
// if the file rejects it the refund stays local and staff settle the credit
// in MYOB manually.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getConnection, myobFetch } from './myob'
import { WORKSHOP_MYOB_LABEL, PaymentTender } from './workshop'
import { getWorkshopSettings, resolveTaxCodes } from './workshop-myob-invoice'
import { logWorkshopActivity } from './workshop-activity'

const UUID_REGEX_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const round2 = (n: number) => Math.round(n * 100) / 100

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export class WorkshopCreditNoteError extends Error {
  code: 'no_source' | 'no_lines' | 'no_amount' | 'over_credit' | 'refund_account_not_set' | 'payment_account_not_set' | 'myob_error'
  constructor(code: WorkshopCreditNoteError['code'], message: string) { super(message); this.code = code }
}

export interface CreateCreditNoteInput {
  booking_id?: string | null
  invoice_id?: string | null
  kind: 'lines' | 'amount'
  line_ids?: string[]                       // source line ids (kind=lines)
  qty_overrides?: Record<string, number>    // source line id → credited qty
  amount?: number                           // inc-GST (kind=amount)
  reason: string
  restock_parts?: boolean
  refund?: { tender: PaymentTender } | null // also pay the money back now
}

export interface CreditNoteResult {
  credit_note_id: string
  cn_number: string
  total_inc: number
  posted_to_myob: boolean
  myob_credit_number: string | null
  myob_warning: string | null               // set when local OK but MYOB leg failed/skipped
  refunded: boolean
  refund_posted_to_myob: boolean
}

const lineEx = (l: any) => l.total_ex_gst != null ? Number(l.total_ex_gst) : (Number(l.qty) || 0) * (Number(l.unit_price_ex_gst) || 0)

export async function createCreditNote(input: CreateCreditNoteInput, performedBy: string | null = null, actorName: string | null = null): Promise<CreditNoteResult> {
  const c = sb()
  if (!input.booking_id && !input.invoice_id) throw new WorkshopCreditNoteError('no_source', 'booking_id or invoice_id required')

  // ── Load the source (job or imported invoice) + its lines ──
  let customerId: string | null = null
  let customerMyobUid: string | null = null
  let sourceTotalInc = 0
  let sourceLines: any[] = []
  let sourceLabel = ''

  if (input.booking_id) {
    const { data: booking, error } = await c.from('workshop_bookings')
      .select('id, customer_id, total_inc_gst, myob_invoice_uid, customer:workshop_customers(id, name, myob_uid)')
      .eq('id', input.booking_id).maybeSingle()
    if (error || !booking) throw new WorkshopCreditNoteError('no_source', error?.message || 'Job not found')
    const cust: any = Array.isArray(booking.customer) ? booking.customer[0] : booking.customer
    customerId = booking.customer_id || null
    customerMyobUid = cust?.myob_uid || null
    sourceTotalInc = round2(Number(booking.total_inc_gst) || 0)
    sourceLabel = `job ${booking.id.slice(0, 8)}`
    const { data: lines } = await c.from('workshop_booking_lines')
      .select('*, inventory:workshop_inventory(myob_uid)')
      .eq('booking_id', input.booking_id).order('sort_order', { ascending: true })
    sourceLines = lines || []
  } else {
    const { data: invoice, error } = await c.from('workshop_invoices')
      .select('id, customer_id, total, booking_id, md_id, customer:workshop_customers(id, name, myob_uid)')
      .eq('id', input.invoice_id!).maybeSingle()
    if (error || !invoice) throw new WorkshopCreditNoteError('no_source', error?.message || 'Invoice not found')
    const cust: any = Array.isArray(invoice.customer) ? invoice.customer[0] : invoice.customer
    customerId = invoice.customer_id || null
    customerMyobUid = cust?.myob_uid || null
    sourceTotalInc = round2(Number(invoice.total) || 0)
    sourceLabel = invoice.md_id ? `invoice #${invoice.md_id}` : `invoice ${invoice.id.slice(0, 8)}`
    const { data: lines } = await c.from('workshop_invoice_lines')
      .select('*, inventory:workshop_inventory(myob_uid)')
      .eq('invoice_id', input.invoice_id!).order('sort_order', { ascending: true })
    sourceLines = lines || []
  }

  // ── Build credit lines + totals (positive numbers; sign applied at push) ──
  let cnLines: any[] = []
  let subtotal = 0, gst = 0
  if (input.kind === 'lines') {
    const wanted = new Set(input.line_ids || [])
    if (!wanted.size) throw new WorkshopCreditNoteError('no_lines', 'Pick at least one line to credit.')
    for (const ln of sourceLines) {
      if (!wanted.has(ln.id)) continue
      const fullQty = Number(ln.qty) || 1
      const qty = Math.min(fullQty, Math.max(0, Number(input.qty_overrides?.[ln.id] ?? fullQty)))
      if (!(qty > 0)) continue
      const unit = fullQty ? round2(lineEx(ln) / fullQty) : round2(lineEx(ln))
      const ex = round2(unit * qty)
      const rate = ln.gst_rate != null ? Number(ln.gst_rate) : 0.10
      const inv: any = Array.isArray(ln.inventory) ? ln.inventory[0] : ln.inventory
      cnLines.push({
        source_line_id: ln.id, line_type: ln.line_type || 'fee', description: ln.description || ln.part_number || ln.line_type,
        part_number: ln.part_number || null, qty, unit_price_ex_gst: unit, gst_rate: rate, total_ex_gst: ex,
        inventory_id: ln.inventory_id || null, sort_order: cnLines.length,
        _myob_item_uid: inv?.myob_uid || null, // not persisted; used for the push
      })
      subtotal += ex
      if (rate > 0) gst += ex * rate
    }
    if (!cnLines.length) throw new WorkshopCreditNoteError('no_lines', 'No creditable lines selected.')
  } else {
    const amountInc = round2(Number(input.amount) || 0)
    if (!(amountInc > 0)) throw new WorkshopCreditNoteError('no_amount', 'Enter a credit amount greater than zero.')
    const ex = round2(amountInc / 1.1)
    cnLines = [{
      source_line_id: null, line_type: 'fee', description: input.reason ? `Credit — ${input.reason}` : 'Credit',
      part_number: null, qty: 1, unit_price_ex_gst: ex, gst_rate: 0.10, total_ex_gst: ex,
      inventory_id: null, sort_order: 0, _myob_item_uid: null,
    }]
    subtotal = ex
    gst = round2(amountInc - ex)
  }
  subtotal = round2(subtotal); gst = round2(gst)
  const totalInc = round2(subtotal + gst)

  // ── Over-credit guard: total of all credits ≤ source total ──
  if (sourceTotalInc > 0) {
    const priorQ = c.from('workshop_credit_notes').select('total_inc').is('deleted_at', null)
    const { data: prior } = input.booking_id ? await priorQ.eq('booking_id', input.booking_id) : await priorQ.eq('invoice_id', input.invoice_id!)
    const priorTotal = round2((prior || []).reduce((s: number, r: any) => s + (Number(r.total_inc) || 0), 0))
    if (totalInc + priorTotal > sourceTotalInc + 0.01) {
      throw new WorkshopCreditNoteError('over_credit', `Credit ($${totalInc.toFixed(2)}) plus prior credits ($${priorTotal.toFixed(2)}) exceeds the ${sourceLabel} total ($${sourceTotalInc.toFixed(2)}).`)
    }
  }

  // ── Insert local record FIRST ──
  const { data: cn, error: cnErr } = await c.from('workshop_credit_notes').insert({
    booking_id: input.booking_id || null, invoice_id: input.invoice_id || null, customer_id: customerId,
    reason: input.reason || null, kind: input.kind,
    subtotal_ex_gst: subtotal, gst, total_inc: totalInc,
    restock_parts: !!input.restock_parts, created_by: performedBy,
  }).select('id, cn_seq').single()
  if (cnErr) throw new Error(`Credit note save failed: ${cnErr.message}`)
  const cnNumber = `CN-${cn.cn_seq}`
  await c.from('workshop_credit_note_lines').insert(cnLines.map(({ _myob_item_uid, ...l }) => ({ ...l, credit_note_id: cn.id })))

  // ── MYOB push (best-effort): negative Sale/Invoice ──
  const settings = await getWorkshopSettings()
  let postedToMyob = false
  let myobNumber: string | null = null
  let myobWarning: string | null = null

  if (!settings.myob_posting_enabled) {
    myobWarning = 'MYOB posting is off — credit recorded locally only.'
  } else if (!customerMyobUid) {
    myobWarning = 'Customer has no MYOB link — credit recorded locally only.'
  } else {
    try {
      const conn = await getConnection(WORKSHOP_MYOB_LABEL)
      if (!conn || !conn.company_file_id) throw new Error(`${WORKSHOP_MYOB_LABEL} MYOB connection not configured`)
      const { gstUid, freUid } = await resolveTaxCodes(conn.id, conn.company_file_id)

      // Item layout only if a Labour item is configured AND restocking was
      // requested where part lines have MYOB items; otherwise Service layout
      // against the refund account keeps it simple and always-valid.
      const useItems = !!settings.labour_item_uid && !!input.restock_parts && cnLines.some(l => l._myob_item_uid)
      const refundAcct = settings.refund_account_uid || settings.part_sale_account_uid || settings.myob_sales_account_uid
      if (!useItems && !refundAcct) throw new WorkshopCreditNoteError('refund_account_not_set', 'No refund/sales account configured in Workshop Settings → MYOB accounts.')

      const myobLines: any[] = []
      for (const l of cnLines) {
        const taxable = Number(l.gst_rate) > 0
        const taxUid = taxable ? gstUid : freUid
        const ex = round2(Number(l.total_ex_gst) || 0)
        const desc = `Credit: ${l.description || l.line_type}${l.part_number ? ` (${l.part_number})` : ''}`.substring(0, 255)
        if (useItems) {
          const itemUid = (l.line_type === 'part' && l._myob_item_uid) ? l._myob_item_uid : settings.labour_item_uid
          myobLines.push({
            Type: 'Transaction', Item: { UID: itemUid }, Description: desc,
            ShipQuantity: -Number(l.qty), UnitPrice: round2(Number(l.unit_price_ex_gst) || 0), // negative qty, positive unit — MYOB rejects negative UnitPrice
            Total: -ex, TaxCode: { UID: taxUid },
          })
        } else {
          myobLines.push({ Type: 'Transaction', Description: desc, Account: { UID: refundAcct }, Total: -ex, TaxCode: { UID: taxUid } })
        }
      }
      const body: Record<string, any> = {
        Customer: { UID: customerMyobUid },
        Date: new Date().toISOString().substring(0, 10),
        Lines: myobLines,
        IsTaxInclusive: false,
        Subtotal: -subtotal,
        TotalTax: -gst,
        TotalAmount: -totalInc,
        Comment: `Credit note ${cnNumber} for ${sourceLabel}${input.reason ? ` — ${input.reason}` : ''}`.substring(0, 255),
        JournalMemo: `Workshop credit note ${cnNumber}`.substring(0, 255),
      }
      if (settings.tracking_category_uid) body.Category = { UID: settings.tracking_category_uid }

      const path = `/accountright/${conn.company_file_id}/Sale/Invoice/${useItems ? 'Item' : 'Service'}`
      const r = await myobFetch(conn.id, path, { method: 'POST', body, performedBy })
      if (r.status !== 201 && r.status !== 200) throw new Error(`MYOB credit POST failed (HTTP ${r.status}): ${(r.raw || '').substring(0, 300)}`)
      const loc = (r.headers || {})['location'] || (r.headers || {})['Location'] || ''
      const uuids = String(loc).match(UUID_REGEX_G) || []
      const uid = uuids[uuids.length - 1] || null
      if (!uid || uid === conn.company_file_id) throw new Error(`MYOB accepted the credit but returned no UID: "${loc}"`)
      try {
        const detail = await myobFetch(conn.id, `${path}/${uid}`)
        if (detail.status === 200 && detail.data?.Number) myobNumber = String(detail.data.Number)
      } catch { /* not fatal */ }
      await c.from('workshop_credit_notes').update({ myob_credit_uid: uid, myob_credit_number: myobNumber, myob_written_at: new Date().toISOString() }).eq('id', cn.id)
      postedToMyob = true
    } catch (e: any) {
      myobWarning = `Credit recorded locally, but the MYOB post failed: ${e?.message || e}`.substring(0, 480)
      await c.from('workshop_credit_notes').update({ myob_write_error: myobWarning }).eq('id', cn.id)
    }
  }

  // ── Refund leg: negative payment row (+ best-effort MYOB CreditRefund) ──
  let refunded = false
  let refundPostedToMyob = false
  if (input.refund?.tender) {
    const acct = (settings.payment_accounts || {})[input.refund.tender]
    await c.from('workshop_payments').insert({
      booking_id: input.booking_id || null, invoice_id: input.invoice_id || null,
      amount: -totalInc, tender: input.refund.tender, kind: 'refund', credit_note_id: cn.id,
      method: acct?.method || null, deposit_account_uid: acct?.uid || null, deposit_account_name: acct?.name || null,
      posted_to_myob: false, note: `Refund for ${cnNumber}${input.reason ? ` — ${input.reason}` : ''}`,
      created_by: performedBy,
    })
    refunded = true
    await c.from('workshop_credit_notes').update({ refunded: true }).eq('id', cn.id)

    // MYOB CreditRefund (pay the customer back from the negative invoice).
    // Rarely-exercised endpoint — fully best-effort.
    if (postedToMyob && acct?.uid) {
      try {
        const conn = await getConnection(WORKSHOP_MYOB_LABEL)
        const { data: cnRow } = await c.from('workshop_credit_notes').select('myob_credit_uid').eq('id', cn.id).maybeSingle()
        if (conn?.company_file_id && cnRow?.myob_credit_uid) {
          const r = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Sale/CreditRefund`, {
            method: 'POST',
            body: {
              Date: new Date().toISOString().substring(0, 10) + 'T00:00:00',
              Customer: { UID: customerMyobUid },
              Account: { UID: acct.uid },
              PaymentMethod: acct.method || 'Other',
              Sale: { UID: cnRow.myob_credit_uid },
              Amount: totalInc,
              Memo: `Workshop refund ${cnNumber}`.substring(0, 255),
            },
            performedBy,
          })
          if (r.status === 201 || r.status === 200) {
            refundPostedToMyob = true
            await c.from('workshop_payments').update({ posted_to_myob: true }).eq('credit_note_id', cn.id).eq('kind', 'refund')
          } else if (!myobWarning) {
            myobWarning = `Credit posted, but the MYOB refund failed (HTTP ${r.status}) — settle the credit in MYOB manually.`
          }
        }
      } catch (e: any) {
        if (!myobWarning) myobWarning = `Credit posted, but the MYOB refund failed: ${e?.message || e}`.substring(0, 480)
      }
    }
  }

  // ── Activity log ──
  await logWorkshopActivity(c, {
    action: 'created', entity: 'credit_note', entity_id: cn.id, entity_label: cnNumber,
    detail: `$${totalInc.toFixed(2)} credit against ${sourceLabel}${input.reason ? ` — ${input.reason}` : ''}${postedToMyob ? ' (MYOB)' : ''}`,
    actor_id: performedBy, actor_name: actorName,
  })
  if (refunded) {
    await logWorkshopActivity(c, {
      action: 'payment', entity: 'credit_note', entity_id: cn.id, entity_label: cnNumber,
      detail: `$${totalInc.toFixed(2)} refunded via ${input.refund!.tender}${refundPostedToMyob ? ' (MYOB)' : ' (local)'}`,
      actor_id: performedBy, actor_name: actorName,
    })
  }

  return {
    credit_note_id: cn.id, cn_number: cnNumber, total_inc: totalInc,
    posted_to_myob: postedToMyob, myob_credit_number: myobNumber, myob_warning: myobWarning,
    refunded, refund_posted_to_myob: refundPostedToMyob,
  }
}

export async function listCreditNotes(filter: { booking_id?: string; invoice_id?: string }): Promise<any[]> {
  const c = sb()
  let qy = c.from('workshop_credit_notes')
    .select('id, cn_seq, booking_id, invoice_id, reason, kind, subtotal_ex_gst, gst, total_inc, restock_parts, myob_credit_uid, myob_credit_number, myob_write_error, refunded, created_at')
    .is('deleted_at', null).order('created_at', { ascending: false })
  if (filter.booking_id) qy = qy.eq('booking_id', filter.booking_id)
  else if (filter.invoice_id) qy = qy.eq('invoice_id', filter.invoice_id)
  const { data } = await qy
  return data || []
}

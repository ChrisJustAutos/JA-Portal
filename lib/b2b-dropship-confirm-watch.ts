// lib/b2b-dropship-confirm-watch.ts
// SERVER-ONLY. Watches the wholesale orders inbox for the SUPPLIER'S
// confirmation of a drop-ship purchase order and runs the receiving flow
// automatically — no Portal clicks (Chris 2026-08-06):
//
//   MPI replies "order confirmed" to orders@justautoswholesale.com
//     → match the email to the open drop-ship PO (PO number / order number /
//       supplier address)
//     → LLM sanity check that it actually CONFIRMS fulfilment (not a
//       backorder, decline or question)
//     → receiveDropShipPo(orderId): PO → Bill (stock into "<SUPPLIER> DS"),
//       sale order → invoice, payment receipting — all existing gates apply.
//
// Idempotency: one b2b_dropship_confirm_log row per message, INSERTED (claimed)
// before any action — the unique (mailbox, graph_message_id) index makes
// overlapping cron runs skip instead of double-processing. receiveDropShipPo
// is additionally claim-guarded internally, so even a manual button click
// racing the cron is safe.
//
// The Portal button ("Supplier confirmed — bill PO + invoice") stays as the
// manual fallback for phone confirmations.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { listMessagesWithAttachments, getMessageBody, GraphMessageSummary } from './microsoft-graph'
import { receiveDropShipPo } from './b2b-dropship-receive'
import { purchaseOrderExists } from './b2b-myob-po'
import { postB2bOrderSlack } from './b2b-slack'

// The inbox supplier PO emails are Reply-To'd + CC'd to (lib/b2b-dropship.ts).
const WATCH_MAILBOX = process.env.B2B_PO_CONFIRM_MAILBOX || 'orders@justautoswholesale.com'
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const CLASSIFY_MODEL = process.env.B2B_PO_CONFIRM_MODEL || 'claude-haiku-4-5-20251001'

// Never treat our own outbound mail (the CC copy of the PO email, portal
// notifications) as a supplier reply.
const SELF_DOMAINS = ['mail.justautos.app', 'justautoswholesale.com', 'justautosmechanical.com.au', 'justautos.app']

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

interface CandidateOrder {
  id: string
  order_number: string
  poUids: string[]           // un-billed PO uids (for the manual-conversion probe)
  poNumbers: string[]        // un-billed PO numbers (e.g. "00000123")
  supplierEmails: string[]   // where each PO email went (emailed_to)
  supplierNames: string[]
}

export interface ConfirmWatchResult {
  scanned: number
  confirmed: number
  healed: number             // manual MYOB conversions detected + finished (payment etc.)
  skipped: number
  errors: string[]
  openOrders: number
}

const stripHtml = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

const emailDomain = (addr: string | null | undefined) => String(addr || '').toLowerCase().split('@')[1] || ''

async function classifyConfirmation(subject: string, bodyText: string, poNumbers: string[], orderNumber: string): Promise<{ confirmed: boolean; reason: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  const system = `You review emails received by an auto-parts wholesaler's orders inbox. The wholesaler emailed a supplier a drop-ship purchase order (PO ${poNumbers.join(' / ') || 'n/a'}, our ref ${orderNumber}) and is waiting for the supplier to CONFIRM they accept and will fulfil/ship it.

Reply ONLY with JSON: {"confirmed": true|false, "reason": "<one short sentence>"}

confirmed=true when the supplier accepts/acknowledges the order, confirms fulfilment or dispatch, sends their sales-order confirmation, invoice or tracking for it.
confirmed=false for: out-of-stock/backorder/delay notices, declines or cancellations, questions that need an answer first (price/address/stock queries), quotes, automated read receipts, marketing, anything ambiguous. When unsure, false.`
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLASSIFY_MODEL, max_tokens: 300, system,
      messages: [{ role: 'user', content: `Subject: ${subject}\n\n${bodyText.slice(0, 6000)}` }],
    }),
  })
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { confirmed: false, reason: 'classifier returned no JSON' }
  try {
    const j = JSON.parse(m[0])
    return { confirmed: j.confirmed === true, reason: String(j.reason || '').slice(0, 300) }
  } catch {
    return { confirmed: false, reason: 'classifier JSON unparseable' }
  }
}

/** Orders with at least one raised, un-billed drop-ship PO. */
async function loadOpenDropShipOrders(c: SupabaseClient): Promise<CandidateOrder[]> {
  const sinceIso = new Date(Date.now() - 90 * 86400_000).toISOString()
  const { data, error } = await c.from('b2b_orders')
    .select('id, order_number, status, dropship_pos, dropship_po_billed_at, created_at')
    .not('dropship_pos', 'is', null)
    .is('dropship_po_billed_at', null)
    .gte('created_at', sinceIso)
    .not('status', 'in', '("cancelled","refunded","pending_payment")')
  if (error) throw new Error(`open drop-ship orders load failed: ${error.message}`)
  const out: CandidateOrder[] = []
  for (const o of (data || []) as any[]) {
    const pos: any[] = Array.isArray(o.dropship_pos) ? o.dropship_pos : []
    const open = pos.filter(p => p?.myob_po_uid && !p?.myob_bill_uid)
    if (open.length === 0) continue
    out.push({
      id: o.id,
      order_number: String(o.order_number || ''),
      poUids: open.map(p => String(p.myob_po_uid || '')).filter(Boolean),
      poNumbers: open.map(p => String(p.myob_po_number || '')).filter(Boolean),
      supplierEmails: open.map(p => String(p.emailed_to || '').toLowerCase()).filter(Boolean),
      supplierNames: open.map(p => String(p.supplier_name || '')).filter(Boolean),
    })
  }
  return out
}

/** Match a message to at most one open order — doc-number hit wins; a
 *  supplier-address hit only counts when it's unambiguous (one open order
 *  for that supplier). */
function matchOrder(candidates: CandidateOrder[], from: string | null, subject: string, bodyText: string): { order: CandidateOrder | null; how: string } {
  const hay = `${subject}\n${bodyText}`.toLowerCase()
  // MYOB PO numbers are zero-padded ("00000123") but suppliers often quote
  // them trimmed — accept both, requiring 3+ significant digits.
  for (const o of candidates) {
    for (const po of o.poNumbers) {
      const trimmed = po.replace(/^0+/, '')
      if (po && hay.includes(po.toLowerCase())) return { order: o, how: `PO ${po} in message` }
      if (trimmed.length >= 3 && new RegExp(`(?<!\\d)${trimmed}(?!\\d)`).test(hay)) return { order: o, how: `PO ${po} (trimmed) in message` }
    }
    if (o.order_number && hay.includes(o.order_number.toLowerCase())) return { order: o, how: `order ${o.order_number} in message` }
  }
  const fromLc = String(from || '').toLowerCase()
  const fromDom = emailDomain(fromLc)
  if (fromLc || fromDom) {
    const bySupplier = candidates.filter(o => o.supplierEmails.some(e => e === fromLc || (fromDom && emailDomain(e) === fromDom)))
    if (bySupplier.length === 1) return { order: bySupplier[0], how: `sole open order for supplier ${fromLc || fromDom}` }
    if (bySupplier.length > 1) return { order: null, how: `ambiguous: ${bySupplier.length} open orders for ${fromDom}` }
  }
  return { order: null, how: 'no PO/order/supplier match' }
}

export async function scanDropShipConfirmations(opts: { lookbackDays?: number } = {}): Promise<ConfirmWatchResult> {
  const c = sb()
  const res: ConfirmWatchResult = { scanned: 0, confirmed: 0, healed: 0, skipped: 0, errors: [], openOrders: 0 }

  const candidates = await loadOpenDropShipOrders(c)
  res.openOrders = candidates.length
  if (candidates.length === 0) return res   // nothing waiting — skip the inbox read entirely

  // ── Reconcile manual MYOB conversions first ─────────────────────────────
  // Staff sometimes bill the PO / convert the invoice straight in the MYOB
  // desktop app (Torrisi B2B-2026-000040). Converting CONSUMES the purchase
  // order, so "PO gone from MYOB" (a definite 404, never a transient error)
  // is the signal — the receive flow then ADOPTS the manual documents and
  // finishes whatever is left (usually the payment receipt).
  for (const order of [...candidates]) {
    try {
      if (order.poUids.length === 0) continue
      const exists = await purchaseOrderExists(order.poUids[0])
      if (exists !== false) continue
      const run = await receiveDropShipPo(order.id)
      if (run.ok) {
        res.healed++
        const idx = candidates.indexOf(order)
        if (idx >= 0) candidates.splice(idx, 1)
      } else {
        res.errors.push(`heal ${order.order_number}: ${run.error || run.steps.filter(s => !s.ok).map(s => s.detail).join('; ')}`.slice(0, 300))
      }
      try {
        await postB2bOrderSlack(c, run.ok
          ? `:link: *${order.order_number}* was converted manually in MYOB — Portal caught up automatically (bill + invoice adopted, payment receipted).`
          : `:warning: *${order.order_number}* looks manually converted in MYOB but the Portal couldn't finish catching up — check the order page.`)
      } catch { /* best-effort */ }
    } catch (e: any) {
      res.errors.push(`heal probe ${order.order_number}: ${String(e?.message || e).slice(0, 200)}`)
    }
  }
  if (candidates.length === 0) return res

  const lookbackDays = Math.min(Math.max(opts.lookbackDays || 7, 1), 30)
  const sinceIso = new Date(Date.now() - lookbackDays * 86400_000).toISOString()
  let messages: GraphMessageSummary[] = []
  try {
    messages = await listMessagesWithAttachments(WATCH_MAILBOX, { sinceIsoDate: sinceIso, top: 300, alsoSubjects: /./ })
  } catch (e: any) {
    res.errors.push(`inbox read failed (${WATCH_MAILBOX}): ${e?.message || e}`)
    return res
  }

  // One query instead of one per message: everything already logged in-window.
  const { data: seenRows } = await c.from('b2b_dropship_confirm_log')
    .select('graph_message_id').eq('mailbox', WATCH_MAILBOX)
    .gte('created_at', new Date(Date.now() - (lookbackDays + 3) * 86400_000).toISOString())
  const seen = new Set((seenRows || []).map((r: any) => r.graph_message_id))

  for (const msg of messages) {
    if (seen.has(msg.id)) continue
    res.scanned++

    // Claim the message BEFORE acting — the unique index turns a concurrent
    // cron overlap into a silent skip instead of a double bill.
    const { error: claimErr } = await c.from('b2b_dropship_confirm_log').insert({
      mailbox: WATCH_MAILBOX, graph_message_id: msg.id, internet_message_id: msg.internetMessageId || null,
      subject: (msg.subject || '').slice(0, 500), from_email: msg.from, received_at: msg.receivedDateTime,
      action: 'processing',
    })
    if (claimErr) { res.skipped++; continue }   // unique violation → another run has it

    const finish = (action: string, detail: string, orderId?: string | null) =>
      c.from('b2b_dropship_confirm_log')
        .update({ action, detail: detail.slice(0, 1000), ...(orderId ? { order_id: orderId } : {}) })
        .eq('mailbox', WATCH_MAILBOX).eq('graph_message_id', msg.id)

    try {
      const fromDom = emailDomain(msg.from)
      if (!msg.from || SELF_DOMAINS.includes(fromDom)) {
        await finish('self', `own/system mail from ${msg.from || 'unknown'}`)
        res.skipped++
        continue
      }

      let bodyText = ''
      try {
        const body = await getMessageBody(WATCH_MAILBOX, msg.id)
        bodyText = body.contentType?.toLowerCase() === 'html' ? stripHtml(body.content) : body.content
      } catch { /* subject-only matching still possible */ }

      const { order, how } = matchOrder(candidates, msg.from, msg.subject || '', bodyText)
      if (!order) {
        await finish('no_match', how)
        res.skipped++
        continue
      }

      const verdict = await classifyConfirmation(msg.subject || '', bodyText, order.poNumbers, order.order_number)
      if (!verdict.confirmed) {
        await finish('not_confirmation', `${how}; classifier: ${verdict.reason}`, order.id)
        res.skipped++
        continue
      }

      const run = await receiveDropShipPo(order.id)
      const summary = run.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.step}: ${s.detail}`).join(' | ')
      await finish(run.ok ? 'confirmed' : 'error', `${how}; classifier: ${verdict.reason}; ${summary || run.error || ''}`, order.id)
      if (run.ok) res.confirmed++
      else res.errors.push(`${order.order_number}: ${run.error || summary}`.slice(0, 300))

      // Tell the team (best-effort — #jaws-orders + the legacy webhook).
      try {
        const supplier = order.supplierNames[0] || emailDomain(msg.from)
        await postB2bOrderSlack(c, run.ok
          ? `:package: ${supplier} confirmed the drop-ship for *${order.order_number}* — PO billed, MYOB invoice + payment done automatically.`
          : `:warning: ${supplier} confirmed the drop-ship for *${order.order_number}* but the automatic receive hit a snag — check the order page. ${String(run.error || '').slice(0, 200)}`)
      } catch (e: any) { console.error('dropship-confirm Slack notify failed:', e?.message || e) }

      // This order's POs are handled — stop matching further messages to it.
      if (run.ok) {
        const idx = candidates.indexOf(order)
        if (idx >= 0) candidates.splice(idx, 1)
        if (candidates.length === 0) break
      }
    } catch (e: any) {
      const msgErr = String(e?.message || e).slice(0, 400)
      res.errors.push(msgErr)
      try { await finish('error', msgErr) } catch { /* log row keeps 'processing' */ }
    }
  }

  return res
}

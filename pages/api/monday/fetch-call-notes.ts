// pages/api/monday/fetch-call-notes.ts
// Pipeline B — Monday "Fetch Call Notes" status-change webhook receiver.
//
// HOW THIS IS WIRED:
//   - Each Quote Channel board has a Status column called "Call Notes" with
//     a label "Fetch Call Notes".
//   - A Monday Webhook (Settings → Integrations → Webhooks) is configured to
//     POST here whenever the column changes. Webhooks accept ONLY a URL —
//     no custom headers, no custom body — so we authenticate via a query
//     string secret and accept Monday's native event payload shape.
//
// FLOW:
//   1. Monday's challenge handshake (one-off, on webhook setup):
//        POST { "challenge": "abc..." }  →  respond 200 { "challenge": "abc..." }
//   2. Real status-change events:
//        POST { event: { pulseId, boardId, columnId, value: { label: { text: "Fetch Call Notes" }}, ... } }
//        a. Verify ?key= matches MONDAY_BUTTON_SECRET.
//        b. If the new label is NOT "Fetch Call Notes", ignore (Monday fires
//           on ALL status-column changes, including reverting back to blank).
//        c. Fetch the Phone column from the item via Monday API.
//        d. Look up the call summary via lib/quote-call-context.ts.
//        e. Post an Update on the item — either the formatted summary or
//           a "no analysed calls" fallback.
//        f. Reset the status column to blank so the rep can fire it again.
//        g. Log to quote_events. Return 200.
//
// IDEMPOTENCY:
//   We don't deduplicate — if Monday retries, the rep gets a duplicate
//   Update. Acceptable: status-change webhooks rarely retry (Monday treats
//   2xx as success), and a duplicate note is a soft failure mode.
//
// NEVER 500 ON ACTUAL EVENTS:
//   Monday retries failed webhooks aggressively. Once we've parsed the event
//   and confirmed the secret, we always return 200 — we record errors in
//   quote_events and post error context as the Update body so the rep sees
//   what went wrong on the item itself.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getQuoteCallContext } from '../../../lib/quote-call-context'
import { createUpdate } from '../../../lib/monday-update'
import { mondayQuery, COLUMNS } from '../../../lib/monday-followup'

export const config = { maxDuration: 30 }

// The status-column LABEL that triggers the lookup. Monday fires the webhook
// on every change to the column (including clearing back to blank), so we
// filter inside the handler.
const TRIGGER_LABEL = 'Fetch Call Notes'

const NO_SUMMARY_BODY =
  '📞 No analysed calls found for this number in the last 30 days.'

// Monday's webhook event shape (the bits we care about). The payload also
// contains pulseName, app, type, triggerTime, etc — we ignore those.
interface MondayWebhookEvent {
  type?: string                 // 'update_column_value', 'change_status_column_value' etc
  pulseId?: number | string
  boardId?: number | string
  columnId?: string
  groupId?: string
  value?: {
    label?: { text?: string; index?: number }
    post_id?: any
  }
  previousValue?: any
}

interface MondayWebhookBody {
  // Challenge handshake shape
  challenge?: string
  // Real event shape
  event?: MondayWebhookEvent
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  const body: MondayWebhookBody = req.body || {}

  // ── 1. Challenge handshake ──────────────────────────────────────────
  // Monday POSTs { "challenge": "abc" } when you save the webhook. We MUST
  // echo the challenge back as JSON, or Monday refuses to register the
  // webhook with: "The provided URL has not returned the requested challenge."
  //
  // Importantly, this happens BEFORE auth — Monday doesn't include any
  // custom params during the handshake. We can't gate this behind ?key=.
  if (typeof body.challenge === 'string') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // ── 2. Auth (URL secret) ────────────────────────────────────────────
  // Monday webhook URLs can include query strings; we check ?key= against
  // MONDAY_BUTTON_SECRET. The webhook URL stored in Monday should look like:
  //   https://ja-portal.vercel.app/api/monday/fetch-call-notes?key=<secret>
  const expected = process.env.MONDAY_BUTTON_SECRET
  if (!expected) {
    console.error('[fetch-call-notes] MONDAY_BUTTON_SECRET not configured')
    return res.status(500).json({ ok: false, error: 'Server not configured' })
  }
  const got = (req.query.key || '') as string
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  // ── 3. Extract event fields ─────────────────────────────────────────
  const ev = body.event
  if (!ev) {
    // Could be a webhook-test ping or unknown shape. Return 200 so Monday
    // doesn't retry; log for debugging.
    console.warn('[fetch-call-notes] POST received without event payload:', JSON.stringify(body).slice(0, 500))
    return res.status(200).json({ ok: true, ignored: 'no event payload' })
  }

  const itemId = ev.pulseId != null ? String(ev.pulseId) : ''
  const boardId = ev.boardId != null ? String(ev.boardId) : ''
  const newLabel = ev.value?.label?.text || ''

  if (!itemId || !boardId) {
    console.warn('[fetch-call-notes] event missing pulseId/boardId:', JSON.stringify(ev).slice(0, 500))
    return res.status(200).json({ ok: true, ignored: 'event missing ids' })
  }

  // ── 4. Filter: only act when status changes TO our trigger label ────
  // Monday fires on every change including the post-action reset back to
  // blank. Without this filter we'd loop or double-fire.
  if (newLabel !== TRIGGER_LABEL) {
    return res.status(200).json({
      ok: true,
      ignored: `status is "${newLabel}", trigger requires "${TRIGGER_LABEL}"`,
    })
  }

  // ── 5. Fetch the phone from the item ───────────────────────────────
  // Webhook payload doesn't include the phone — only the column that
  // changed (status). Read the Phone column directly via Monday API.
  let phone: string | null = null
  try {
    phone = await fetchItemPhone(itemId)
  } catch (e: any) {
    console.error('[fetch-call-notes] fetchItemPhone failed:', e?.message || e)
    await postErrorAndLog(itemId, boardId, null, 'failed', {
      error: e?.message || String(e),
      where: 'fetchItemPhone',
    }, t0)
    return res.status(200).json({ ok: true, error: 'fetchItemPhone failed' })
  }

  if (!phone) {
    await postErrorAndLog(itemId, boardId, null, 'no_summary_posted', {
      reason: 'no phone on item',
    }, t0, '📞 No phone number on this item — add one and try again.')
    await resetStatus(itemId, boardId, ev.columnId)
    return res.status(200).json({ ok: true, action: 'no_phone' })
  }

  // ── 6. Look up the call summary ────────────────────────────────────
  let context: Awaited<ReturnType<typeof getQuoteCallContext>>
  try {
    context = await getQuoteCallContext(phone)
  } catch (e: any) {
    console.error('[fetch-call-notes] context lookup threw:', e?.message || e)
    await postErrorAndLog(itemId, boardId, phone, 'failed', {
      error: e?.message || String(e),
      where: 'getQuoteCallContext',
    }, t0, NO_SUMMARY_BODY)
    await resetStatus(itemId, boardId, ev.columnId)
    return res.status(200).json({ ok: true, error: 'lookup failed' })
  }

  // ── 7. Post the Update ─────────────────────────────────────────────
  const updateBody = context ? context.formatted : NO_SUMMARY_BODY
  const action: 'summary_posted' | 'no_summary_posted' = context
    ? 'summary_posted'
    : 'no_summary_posted'

  try {
    await createUpdate(itemId, updateBody)
  } catch (e: any) {
    console.error('[fetch-call-notes] createUpdate failed:', e?.message || e)
    await logEvent({
      itemId,
      boardId,
      phone,
      callId: context?.callId || null,
      action: 'failed',
      status: 'failed',
      detailsExtra: { error: e?.message || String(e), where: 'createUpdate' },
      durationMs: Date.now() - t0,
    })
    await resetStatus(itemId, boardId, ev.columnId)
    return res.status(200).json({ ok: true, error: 'createUpdate failed' })
  }

  // ── 8. Reset the status so the rep can fire it again ──────────────
  // Best-effort: don't fail the request if reset fails; the Update is
  // already posted. Reset uses the SAME columnId Monday told us about.
  await resetStatus(itemId, boardId, ev.columnId)

  // ── 9. Log success ─────────────────────────────────────────────────
  await logEvent({
    itemId,
    boardId,
    phone,
    callId: context?.callId || null,
    action,
    status: 'success',
    detailsExtra: context
      ? { matchedCallAt: context.calledAt, outcome: context.outcome, agentName: context.agentName }
      : { reason: 'no analysed call within 30 days' },
    durationMs: Date.now() - t0,
  })

  return res.status(200).json({
    ok: true,
    action,
    callId: context?.callId,
    durationMs: Date.now() - t0,
  })
}

// ── Helper: read the phone from the item ────────────────────────────────
// Reads the standard PHONE column ID (text_mkzbenay) defined in
// lib/monday-followup.ts COLUMNS.PHONE. All 5 Quote Channel boards share
// this column ID since they were forked from the same template.
async function fetchItemPhone(itemId: string): Promise<string | null> {
  const data = await mondayQuery<{ items: Array<{ column_values: Array<{ text: string | null }> }> }>(
    `query GetItemPhone($itemId: [ID!]) {
      items(ids: $itemId) {
        column_values(ids: ["${COLUMNS.PHONE}"]) { text }
      }
    }`,
    { itemId: [itemId] },
  )
  const text = data.items?.[0]?.column_values?.[0]?.text || null
  return text && text.trim() ? text.trim() : null
}

// ── Helper: reset the trigger status column back to blank ──────────────
// Pass the columnId from the event (which is the trigger column itself,
// not the standard `status` column). This makes the recipe re-usable —
// the rep can change to "Fetch Call Notes" again to get fresh notes.
async function resetStatus(itemId: string, boardId: string, columnId: string | undefined): Promise<void> {
  if (!columnId) return
  try {
    // Monday's `change_simple_column_value` with an empty string clears
    // a status column.
    await mondayQuery(
      `mutation ResetStatus($itemId: ID!, $boardId: ID!, $columnId: String!) {
        change_simple_column_value(
          item_id: $itemId
          board_id: $boardId
          column_id: $columnId
          value: ""
        ) { id }
      }`,
      { itemId, boardId, columnId },
    )
  } catch (e: any) {
    console.warn('[fetch-call-notes] resetStatus failed (non-fatal):', e?.message || e)
  }
}

// ── Helper: convenience wrapper to post an error message + log ─────────
async function postErrorAndLog(
  itemId: string,
  boardId: string,
  phone: string | null,
  action: 'failed' | 'no_summary_posted',
  detailsExtra: Record<string, any>,
  t0: number,
  visibleBody?: string,
): Promise<void> {
  if (visibleBody) {
    try {
      await createUpdate(itemId, visibleBody)
    } catch (e) {
      console.warn('[fetch-call-notes] failed to post error update:', e)
    }
  }
  await logEvent({
    itemId,
    boardId,
    phone,
    callId: null,
    action,
    status: action === 'failed' ? 'failed' : 'partial',
    detailsExtra,
    durationMs: Date.now() - t0,
  })
}

// ── Audit logger ────────────────────────────────────────────────────────

interface LogEventInput {
  itemId: string
  boardId: string | null
  phone: string | null
  callId: string | null
  action: 'summary_posted' | 'no_summary_posted' | 'failed'
  status: 'success' | 'partial' | 'failed'
  detailsExtra: Record<string, any>
  durationMs: number
}

async function logEvent(input: LogEventInput): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[fetch-call-notes] cannot log event — Supabase env not configured')
    return
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const mondayAction =
    input.action === 'summary_posted' ? 'update_posted'
    : input.action === 'no_summary_posted' ? 'no_summary_posted'
    : 'failed'

  const row = {
    pipeline: 'B_button_fetch',
    customer_phone: input.phone,
    monday_item_id: input.itemId,
    monday_board_id: input.boardId,
    monday_action: mondayAction,
    call_summary_found: input.action === 'summary_posted',
    matched_call_id: input.callId,
    details: input.detailsExtra,
    completed_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    status: input.status,
  }

  const { error } = await sb.from('quote_events').insert(row)
  if (error) {
    console.warn('[fetch-call-notes] quote_events insert failed:', error.message)
  }
}

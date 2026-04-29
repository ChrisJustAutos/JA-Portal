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
//        b. If the new label is NOT "Fetch Call Notes", ignore.
//        c. Fetch the Phone column from the item via Monday API.
//        d. Look up OR generate the call summary via lib/quote-call-context.ts
//           (generateOnDemand=true — if no summary exists but a transcript
//           does, fire Claude to make one).
//        e. Post an Update on the item — formatted summary or fallback.
//        f. Reset the status column to blank so the rep can fire it again.
//        g. Log to quote_events. Return 200.
//
// NEVER 500 ON ACTUAL EVENTS:
//   Monday retries failed webhooks aggressively. Once we've parsed the event
//   and confirmed the secret, we always return 200 — we record errors in
//   quote_events and post error context as the Update body.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getQuoteCallContext } from '../../../lib/quote-call-context'
import { createUpdate } from '../../../lib/monday-update'
import { mondayQuery, COLUMNS } from '../../../lib/monday-followup'

// On-demand generation can take 5-10s with Claude. Bump max duration so the
// function isn't killed mid-call. Monday webhook timeout is ~30s.
export const config = { maxDuration: 30 }

const TRIGGER_LABEL = 'Fetch Call Notes'

const NO_SUMMARY_BODY =
  '📞 No analysed calls found for this number in the last 30 days.'

interface MondayWebhookEvent {
  type?: string
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
  challenge?: string
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
  if (typeof body.challenge === 'string') {
    return res.status(200).json({ challenge: body.challenge })
  }

  // ── 2. Auth (URL secret) ────────────────────────────────────────────
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
    console.warn('[fetch-call-notes] POST without event payload:', JSON.stringify(body).slice(0, 500))
    return res.status(200).json({ ok: true, ignored: 'no event payload' })
  }

  const itemId = ev.pulseId != null ? String(ev.pulseId) : ''
  const boardId = ev.boardId != null ? String(ev.boardId) : ''
  const newLabel = ev.value?.label?.text || ''

  if (!itemId || !boardId) {
    console.warn('[fetch-call-notes] event missing ids:', JSON.stringify(ev).slice(0, 500))
    return res.status(200).json({ ok: true, ignored: 'event missing ids' })
  }

  // ── 4. Filter: only act on the trigger label ────────────────────────
  if (newLabel !== TRIGGER_LABEL) {
    return res.status(200).json({
      ok: true,
      ignored: `status is "${newLabel}", trigger requires "${TRIGGER_LABEL}"`,
    })
  }

  // ── 5. Fetch the phone from the item ───────────────────────────────
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

  // ── 6. Look up OR generate the call summary ────────────────────────
  // generateOnDemand=true: if a transcript exists but no follow_up_summary,
  // fire Claude. Adds ~3-5s latency on misses. Result is persisted.
  let context: Awaited<ReturnType<typeof getQuoteCallContext>>
  try {
    context = await getQuoteCallContext(phone, { generateOnDemand: true })
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
      ? {
          matchedCallAt: context.calledAt,
          outcome: context.outcome,
          agentName: context.agentName,
          generatedOnDemand: context.generatedOnDemand,   // telemetry: how often we generate vs cache-hit
        }
      : { reason: 'no analysed call within 30 days, or generation failed' },
    durationMs: Date.now() - t0,
  })

  return res.status(200).json({
    ok: true,
    action,
    callId: context?.callId,
    generatedOnDemand: context?.generatedOnDemand,
    durationMs: Date.now() - t0,
  })
}

// ── Helper: read the phone from the item ────────────────────────────────
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
async function resetStatus(itemId: string, boardId: string, columnId: string | undefined): Promise<void> {
  if (!columnId) return
  try {
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

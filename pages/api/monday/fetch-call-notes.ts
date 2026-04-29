// pages/api/monday/fetch-call-notes.ts
// Pipeline B — Monday "Fetch Call Notes" button endpoint.
//
// Flow when a rep clicks the button on a Quote Channel item:
//   1. Monday's integration recipe POSTs { itemId, phone, boardId } here.
//   2. We auth-check via shared bearer token (MONDAY_BUTTON_SECRET).
//   3. Look up the most recent analysed call within 30 days for the phone
//      via lib/quote-call-context.ts (same helper Pipeline A uses).
//   4. Post an Update on the Monday item:
//        - If summary found: the formatted call note (header + sentiment +
//          who/discussed/objections/promised/next step).
//        - If not found: a one-liner "No analysed calls found in last 30 days".
//   5. Log a row to quote_events for audit/debugging.
//   6. Return 200 quickly. The user-visible output is the Update on the item.
//
// Why a shared-secret instead of signature verification: Monday's integration
// recipes don't sign the same way webhook subscriptions do, and the recipe
// authoring UI lets us add custom headers easily. Token in Vercel env, sent
// in `x-monday-button-secret` header. Rotate if leaked.
//
// Why we ALWAYS post an Update (even on "no summary found"): the rep clicked
// a button expecting a response. Silent failure is worse than "nothing yet".

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { getQuoteCallContext } from '../../../lib/quote-call-context'
import { createUpdate } from '../../../lib/monday-update'

export const config = { maxDuration: 30 }   // 30s is plenty; lookup+post is sub-second

interface RequestBody {
  itemId?: string | number
  phone?: string
  boardId?: string | number
}

interface OkResponse {
  ok: true
  action: 'summary_posted' | 'no_summary_posted'
  callId?: string
  durationMs: number
}

interface ErrorResponse {
  ok: false
  error: string
  durationMs: number
}

const NO_SUMMARY_BODY =
  '📞 No analysed calls found for this number in the last 30 days.'

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OkResponse | ErrorResponse>,
) {
  const t0 = Date.now()

  // ── Method gate ─────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed', durationMs: 0 })
  }

  // ── Auth: shared bearer token ───────────────────────────────────────
  // Set MONDAY_BUTTON_SECRET in Vercel env; configure the Monday integration
  // recipe to send it as `x-monday-button-secret`. Anything else is rejected.
  const expected = process.env.MONDAY_BUTTON_SECRET
  if (!expected) {
    console.error('[fetch-call-notes] MONDAY_BUTTON_SECRET not configured')
    return res.status(500).json({ ok: false, error: 'Server not configured', durationMs: Date.now() - t0 })
  }
  const got = (req.headers['x-monday-button-secret'] || '') as string
  if (got !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized', durationMs: Date.now() - t0 })
  }

  // ── Parse + validate body ───────────────────────────────────────────
  // Monday integration recipes can send numbers OR strings depending on how
  // the recipe was built. Coerce both into strings before anything else.
  const body: RequestBody = req.body || {}
  const itemId = body.itemId != null ? String(body.itemId).trim() : ''
  const phone = body.phone ? String(body.phone).trim() : ''
  const boardId = body.boardId != null ? String(body.boardId).trim() : ''

  if (!itemId) {
    return res.status(400).json({ ok: false, error: 'Missing itemId', durationMs: Date.now() - t0 })
  }
  if (!phone) {
    // Phone-less items can't be matched to a call. Tell Monday so the rep sees
    // it on the item itself rather than digging through quote_events.
    try {
      await createUpdate(itemId, '📞 No phone number on this item — add one and try again.')
    } catch (e) {
      console.warn('[fetch-call-notes] failed to post no-phone update:', e)
    }
    await logEvent({
      itemId,
      boardId: boardId || null,
      phone: null,
      callId: null,
      action: 'no_summary_posted',
      status: 'partial',
      detailsExtra: { reason: 'no phone on item' },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: true,
      action: 'no_summary_posted',
      durationMs: Date.now() - t0,
    })
  }

  // ── Look up the call summary ────────────────────────────────────────
  let context: Awaited<ReturnType<typeof getQuoteCallContext>>
  try {
    context = await getQuoteCallContext(phone)
  } catch (e: any) {
    // The lookup helper is best-effort and shouldn't throw, but if Supabase
    // is down or env is misconfigured, post a graceful message and log.
    console.error('[fetch-call-notes] context lookup threw:', e?.message || e)
    try {
      await createUpdate(itemId, NO_SUMMARY_BODY)
    } catch {}
    await logEvent({
      itemId,
      boardId: boardId || null,
      phone,
      callId: null,
      action: 'failed',
      status: 'failed',
      detailsExtra: { error: e?.message || String(e), where: 'getQuoteCallContext' },
      durationMs: Date.now() - t0,
    })
    return res.status(500).json({
      ok: false,
      error: 'Lookup failed',
      durationMs: Date.now() - t0,
    })
  }

  // ── Post the appropriate Update on the Monday item ──────────────────
  const updateBody = context ? context.formatted : NO_SUMMARY_BODY
  const action: OkResponse['action'] = context ? 'summary_posted' : 'no_summary_posted'

  try {
    await createUpdate(itemId, updateBody)
  } catch (e: any) {
    console.error('[fetch-call-notes] createUpdate failed:', e?.message || e)
    await logEvent({
      itemId,
      boardId: boardId || null,
      phone,
      callId: context?.callId || null,
      action: 'failed',
      status: 'failed',
      detailsExtra: { error: e?.message || String(e), where: 'createUpdate' },
      durationMs: Date.now() - t0,
    })
    return res.status(502).json({
      ok: false,
      error: 'Failed to post update on Monday',
      durationMs: Date.now() - t0,
    })
  }

  // ── Log success ─────────────────────────────────────────────────────
  await logEvent({
    itemId,
    boardId: boardId || null,
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

// ── Audit logger ────────────────────────────────────────────────────────
// Writes one row per request to public.quote_events. Failures here are
// logged but do NOT fail the response — the user's Update was already
// posted, and quote_events being unavailable shouldn't break the UX.

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

  // Map our action to the quote_events.monday_action enum:
  //   'summary_posted'    → 'update_posted'
  //   'no_summary_posted' → 'no_summary_posted'
  //   'failed'            → 'failed'
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

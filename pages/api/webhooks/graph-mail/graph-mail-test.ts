// pages/api/webhooks/graph-mail/graph-mail-test.ts
// Pipeline A — STUB-MODE endpoint for end-to-end testing without Microsoft Graph.
//
// REWRITTEN 29 Apr 2026 (round 4) — Monday sync wired in (step 6).
// Architecture: Zapier replacement. AC deals land at Quote Sent stage 38.
// Monday flow lives in lib/quote-pipeline-monday.ts.
//
// AUTH_DIAG block can be removed now that auth is reliable, but leaving it
// since it's harmless and useful when Vercel env vars get tweaked.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { extractQuoteFromPdf, ExtractedQuote } from '../../../../lib/quote-extraction'
import { resolveContactForCall } from '../../../../lib/activecampaign'
import { applyQuoteRecencyRule } from '../../../../lib/activecampaign-deals'
import { getQuoteCallContext } from '../../../../lib/quote-call-context'
import { getAgentByMailbox, listConfiguredMailboxes } from '../../../../lib/agents'
import { syncQuoteToMonday, type SyncQuoteToMondayResult } from '../../../../lib/quote-pipeline-monday'

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
  maxDuration: 60,
}

interface RequestBody {
  agentEmail?: string
  pdfBase64?: string
  pdfFilename?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const t0 = Date.now()

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  // ── Auth (URL secret) — WITH AUTH_DIAG ──────────────────────────────
  const expected = process.env.QUOTE_STUB_SECRET
  const got = (req.query.key as string) || ''

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'QUOTE_STUB_SECRET not configured' })
  }
  if (got !== expected) {
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      diag: {
        envVarPresent: true,
        expectedLength: expected.length,
        gotLength: got.length,
        match: got === expected,
      },
    })
  }

  // ── Validate body ───────────────────────────────────────────────────
  const body: RequestBody = req.body || {}
  const agentEmail = (body.agentEmail || '').trim()
  const pdfBase64 = (body.pdfBase64 || '').trim()
  const pdfFilename = body.pdfFilename || null

  if (!agentEmail) return res.status(400).json({ ok: false, error: 'Missing agentEmail in body' })
  if (!pdfBase64) return res.status(400).json({ ok: false, error: 'Missing pdfBase64 in body' })

  // ── 1. Resolve agent ───────────────────────────────────────────────
  const agent = getAgentByMailbox(agentEmail)
  if (!agent) {
    await logEvent({
      agentEmail, pdfFilename,
      action: 'failed', status: 'failed',
      detailsExtra: {
        where: 'agent lookup',
        error: `agent for mailbox ${agentEmail} not in AGENTS map`,
        configuredMailboxes: listConfiguredMailboxes(),
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false,
      error: `Unknown agent mailbox: ${agentEmail}`,
      configuredMailboxes: listConfiguredMailboxes(),
    })
  }

  // ── 2. Parse the PDF ────────────────────────────────────────────────
  let extracted: ExtractedQuote
  let parseDurationMs = 0
  try {
    const tParse = Date.now()
    const result = await extractQuoteFromPdf(pdfBase64)
    parseDurationMs = Date.now() - tParse
    extracted = result.quote
  } catch (e: any) {
    await logEvent({
      agentEmail, pdfFilename,
      action: 'failed', status: 'failed',
      detailsExtra: { where: 'extractQuoteFromPdf', error: e?.message || String(e) },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({ ok: false, stage: 'parse', error: e?.message || String(e) })
  }

  // ── 3. Resolve AC contact ──────────────────────────────────────────
  const whoWhat = buildWhoWhatFromQuote(extracted)
  let acResolve
  try {
    acResolve = await resolveContactForCall({
      phone: extracted.customer.phone,
      email: extracted.customer.email,
      whoWhat,
      agentName: agent.name,
    })
  } catch (e: any) {
    await logEvent({
      agentEmail, pdfFilename,
      action: 'failed', status: 'failed',
      detailsExtra: {
        where: 'resolveContactForCall',
        error: e?.message || String(e),
        parsed: previewableQuote(extracted),
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false, stage: 'ac_contact_resolve',
      error: e?.message || String(e),
      parsed: previewableQuote(extracted),
    })
  }

  if (!acResolve.contact) {
    await logEvent({
      agentEmail, pdfFilename,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      action: 'skipped', status: 'partial',
      detailsExtra: {
        where: 'ac_contact_resolve',
        reason: acResolve.reason,
        action: acResolve.action,
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false, stage: 'ac_contact_resolve',
      reason: acResolve.reason,
      parsed: previewableQuote(extracted),
    })
  }

  // ── 4. Look up most recent call summary (best-effort) ──────────────
  let callContext: Awaited<ReturnType<typeof getQuoteCallContext>> = null
  if (extracted.customer.phone) {
    try {
      callContext = await getQuoteCallContext(extracted.customer.phone)
    } catch (e: any) {
      console.warn('[graph-mail/test] call context lookup failed (non-fatal):', e?.message || e)
    }
  }

  // ── 5. Apply the 30-day recency rule on AC deals ──────────────────
  let recencyResult
  try {
    const ownerId = ownerIdFromAgentName(agent.name)
    recencyResult = await applyQuoteRecencyRule({
      contactId: acResolve.contact.id,
      agentName: agent.name,
      ownerId,
      quoteNumber: extracted.quote.number,
      totalIncGst: extracted.quote.totalIncGst,
      totalExGst: extracted.quote.totalExGst,
      vehicleMakeModel: extracted.vehicle.makeModel,
      vehicleRego: extracted.vehicle.rego,
      callContextNote: callContext?.formatted || null,
    })
  } catch (e: any) {
    await logEvent({
      agentEmail, pdfFilename,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      acContactId: acResolve.contact.id,
      action: 'failed', status: 'failed',
      detailsExtra: {
        where: 'applyQuoteRecencyRule',
        error: e?.message || String(e),
        parsed: previewableQuote(extracted),
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false, stage: 'ac_deal_recency',
      error: e?.message || String(e),
      parsed: previewableQuote(extracted),
      acContact: { id: acResolve.contact.id, action: acResolve.action },
    })
  }

  // ── 6. Sync to Monday (NEW) ────────────────────────────────────────
  let mondaySync: SyncQuoteToMondayResult | null = null
  let mondayError: string | null = null

  // Skip Monday entirely in preview mode (we don't want to create real
  // Monday items when the AC side is dry-running).
  if (!recencyResult.preview) {
    try {
      const customerName = [extracted.customer.firstName, extracted.customer.lastName]
        .filter(Boolean)
        .join(' ')
        .trim()
        || extracted.customer.name
        || 'Unknown customer'

      const dealValue = extracted.quote.totalIncGst != null
        ? extracted.quote.totalIncGst
        : (extracted.quote.totalExGst != null ? extracted.quote.totalExGst * 1.1 : 0)

      const mondayNote = buildMondayNoteBody(extracted, callContext, agent.name)

      mondaySync = await syncQuoteToMonday({
        agentName: agent.name,
        acDecision: recencyResult.decision.action,
        customerName,
        phone: extracted.customer.phone,
        email: extracted.customer.email,
        postcode: extracted.customer.postcode,
        quoteNumber: extracted.quote.number,
        quoteValueIncGst: dealValue,
        noteBody: mondayNote,
        pdfBase64,
        pdfFilename: pdfFilename || `quote-${extracted.quote.number}.pdf`,
        callDate: callContext?.latestCallDate || null,
      })
    } catch (e: any) {
      mondayError = e?.message || String(e)
      console.error('[graph-mail/test] syncQuoteToMonday failed:', mondayError)
    }
  }

  // ── 7. Log final outcome to quote_events ──────────────────────────
  const acActionForLog =
    recencyResult.preview ? 'skipped'
    : recencyResult.decision.action === 'create' ? 'deal_created'
    : 'deal_updated'

  await logEvent({
    agentEmail, pdfFilename,
    customerEmail: extracted.customer.email,
    customerPhone: extracted.customer.phone,
    quoteNumber: extracted.quote.number,
    quoteTotalIncGst: extracted.quote.totalIncGst,
    vehicleRego: extracted.vehicle.rego,
    acContactId: acResolve.contact.id,
    acAction: acActionForLog,
    acDealId: recencyResult.dealId,
    callId: callContext?.latestCallId || null,
    callSummaryFound: !!callContext,
    mondayAction: mondaySync?.action || null,
    mondayBoardId: mondaySync?.boardId || null,
    mondayItemId: mondaySync?.itemId || null,
    mondayError: mondayError,
    action: mondayError ? 'failed' : 'summary_posted',
    status: mondayError ? 'partial' : (recencyResult.preview ? 'partial' : 'success'),
    detailsExtra: {
      stub: true,
      previewMode: recencyResult.preview,
      contactAction: acResolve.action,
      contactBackfilled: acResolve.backfilled,
      contactOwnerSet: acResolve.ownerSet,
      recencyDecision: recencyResult.decision,
      recencyDetails: recencyResult.details,
      callContextSource: callContext ? `${callContext.callCount} call(s)` : 'no calls / no phone',
      parsedSummary: previewableQuote(extracted),
      parseDurationMs,
      mondaySync: mondaySync ? {
        action: mondaySync.action,
        matchSource: mondaySync.matchSource,
        boardName: mondaySync.boardName,
        prevQuoteValue: mondaySync.prevQuoteValue,
        newQuoteValue: mondaySync.newQuoteValue,
        pdfUploaded: mondaySync.pdfUpload?.uploaded ?? null,
        pdfError: mondaySync.pdfUpload?.error ?? null,
      } : null,
    },
    durationMs: Date.now() - t0,
  })

  // ── 8. Final response ─────────────────────────────────────────────
  return res.status(200).json({
    ok: !mondayError,
    durationMs: Date.now() - t0,
    agent: { mailbox: agentEmail, name: agent.name, mondayBoardId: agent.mondayBoardId },
    parsed: {
      quoteNumber: extracted.quote.number,
      totalIncGst: extracted.quote.totalIncGst,
      customer: {
        email: extracted.customer.email,
        phone: extracted.customer.phone,
        name: extracted.customer.name,
        postcode: extracted.customer.postcode,
      },
      vehicle: extracted.vehicle,
      lineItemCount: extracted.quote.lineItems.length,
    },
    ac: {
      contact: {
        id: acResolve.contact.id,
        action: acResolve.action,
        backfilled: acResolve.backfilled,
        ownerSet: acResolve.ownerSet,
      },
      deal: {
        decision: recencyResult.decision.action,
        reason: recencyResult.decision.reason,
        dealId: recencyResult.dealId,
        previewMode: recencyResult.preview,
        existingDealsCount: recencyResult.details.existingDealsCount,
        landedAtStageId: recencyResult.details.landedAtStageId,
      },
    },
    call: callContext
      ? {
          found: true,
          latestCallAt: callContext.latestCallDate,
          callCount: callContext.callCount,
          sentiment: callContext.summary.sentiment,
        }
      : { found: false },
    monday: mondaySync ? {
      action: mondaySync.action,
      matchSource: mondaySync.matchSource,
      boardId: mondaySync.boardId,
      boardName: mondaySync.boardName,
      itemId: mondaySync.itemId,
      prevQuoteValue: mondaySync.prevQuoteValue,
      newQuoteValue: mondaySync.newQuoteValue,
      pdfUploaded: mondaySync.pdfUpload?.uploaded ?? null,
      pdfError: mondaySync.pdfUpload?.error ?? null,
    } : { skipped: recencyResult.preview ? 'preview_mode' : 'monday_sync_failed', error: mondayError },
  })
}

// ── helpers ────────────────────────────────────────────────────────────

function buildWhoWhatFromQuote(q: ExtractedQuote): string {
  const name = [q.customer.firstName, q.customer.lastName].filter(Boolean).join(' ')
    || q.customer.name
    || 'Unknown caller'
  const vehiclePart = q.vehicle.makeModel ? ` with a ${q.vehicle.makeModel}` : ''
  return `${name}${vehiclePart} regarding quote ${q.quote.number}`
}

function ownerIdFromAgentName(agentName: string): number | null {
  const raw = process.env.ACTIVECAMPAIGN_OWNER_MAP || '{}'
  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const lower: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) lower[k.toLowerCase()] = Number(v)
    return lower[agentName.toLowerCase()] || null
  } catch {
    return null
  }
}

function previewableQuote(q: ExtractedQuote): any {
  return {
    customer: q.customer,
    vehicle: q.vehicle,
    quote: {
      number: q.quote.number,
      issuedDate: q.quote.issuedDate,
      totalExGst: q.quote.totalExGst,
      totalIncGst: q.quote.totalIncGst,
      gstAmount: q.quote.gstAmount,
      lineItemCount: q.quote.lineItems.length,
      lineItemsPreview: q.quote.lineItems.slice(0, 5),
    },
  }
}

/**
 * Build the Update body for the Monday item — line items, totals, and call
 * context if any. Plain-text Monday updates render markdown-ish (line breaks
 * are preserved). Keep it scannable for the rep.
 */
function buildMondayNoteBody(
  q: ExtractedQuote,
  call: Awaited<ReturnType<typeof getQuoteCallContext>>,
  repName: string,
): string {
  const lines: string[] = []
  lines.push(`📄 Quote ${q.quote.number} — sent ${new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' })}`)
  lines.push(`Rep: ${repName}`)
  if (q.vehicle.makeModel) {
    lines.push(`Vehicle: ${q.vehicle.makeModel}${q.vehicle.rego ? ` (${q.vehicle.rego})` : ''}`)
  }
  if (q.quote.totalExGst != null) {
    lines.push(`Total: $${q.quote.totalExGst.toFixed(2)} ex GST / $${(q.quote.totalIncGst ?? q.quote.totalExGst * 1.1).toFixed(2)} inc GST`)
  }
  lines.push('')
  lines.push('── Line items ──')
  for (const item of q.quote.lineItems) {
    const qty = item.quantity ? `${item.quantity}× ` : ''
    const price = item.totalExGst != null ? ` — $${item.totalExGst.toFixed(2)}` : ''
    lines.push(`• ${qty}${item.description}${price}`)
  }
  if (call?.formatted) {
    lines.push('')
    lines.push('── Recent call context ──')
    lines.push(call.formatted)
  }
  return lines.join('\n')
}

interface LogEventInput {
  agentEmail: string
  pdfFilename: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  quoteNumber?: string | null
  quoteTotalIncGst?: number | null
  vehicleRego?: string | null
  acContactId?: number | null
  acAction?: 'contact_created' | 'contact_updated' | 'deal_created' | 'deal_updated' | 'skipped' | 'failed' | null
  acDealId?: number | null
  callId?: string | null
  callSummaryFound?: boolean
  mondayAction?: string | null
  mondayBoardId?: string | null
  mondayItemId?: string | null
  mondayError?: string | null
  action: 'summary_posted' | 'no_summary_posted' | 'failed' | 'skipped'
  status: 'success' | 'partial' | 'failed'
  detailsExtra: Record<string, any>
  durationMs: number
}

async function logEvent(input: LogEventInput): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[graph-mail/test] cannot log event — Supabase env not configured')
    return
  }
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const row: any = {
    pipeline: 'A_quote_ingestion',
    agent_email: input.agentEmail,
    customer_email: input.customerEmail || null,
    customer_phone: input.customerPhone || null,
    quote_number: input.quoteNumber || null,
    quote_total_inc_gst: input.quoteTotalIncGst ?? null,
    vehicle_rego: input.vehicleRego || null,
    ac_action: input.acAction || null,
    ac_contact_id: input.acContactId ?? null,
    ac_deal_id: input.acDealId ?? null,
    call_summary_found: input.callSummaryFound ?? null,
    matched_call_id: input.callId || null,
    monday_action: input.mondayAction || null,
    monday_board_id: input.mondayBoardId || null,
    monday_item_id: input.mondayItemId || null,
    monday_error: input.mondayError || null,
    details: { ...input.detailsExtra, pdfFilename: input.pdfFilename },
    completed_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    status: input.status,
  }

  const { error } = await sb.from('quote_events').insert(row)
  if (error) {
    console.warn('[graph-mail/test] quote_events insert failed:', error.message)
  }
}

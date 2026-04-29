// pages/api/webhooks/graph-mail/test.ts
// Pipeline A — STUB-MODE endpoint for end-to-end testing without Microsoft Graph.
//
// Accepts a PDF + agent email directly via POST, runs the full Pipeline A
// pipeline downstream of the trigger:
//   1. Parse the quote PDF via Claude (lib/quote-extraction.ts).
//   2. Resolve / create the AC contact (lib/activecampaign.ts).
//   3. Apply the 30-day recency rule on the AC deal side
//      (lib/activecampaign-deals.ts).
//   4. Look up the most recent call summary for the customer's phone
//      (lib/quote-call-context.ts — generates on-demand if needed).
//   5. Log everything to quote_events (pipeline='A_quote_ingestion').
//
// What this endpoint does NOT yet do (reserved for next build session):
//   - Phone-match Monday + update item columns + upload PDF (Step 8).
//   - Microsoft Graph trigger handling (Step 9 production cutover).
//
// SAFETY:
//   - Bearer secret in URL (?key=<secret>) — set QUOTE_STUB_SECRET in Vercel.
//   - AC_DEAL_PREVIEW_ONLY=true is the default behaviour during testing.
//     Set to false in env only after you've eyeballed 2-3 real-quote
//     decisions and they look right.
//
// REQUEST SHAPE:
//   POST /api/webhooks/graph-mail/test?key=<QUOTE_STUB_SECRET>
//   Content-Type: application/json
//   {
//     "agentEmail":   "kaleb@justautosmechanical.com.au",   // who received the quote
//     "pdfBase64":    "JVBERi0xLjQKJ...",                   // base64-encoded PDF
//     "pdfFilename":  "Quote-12345.pdf"                     // optional, for logging
//   }
//
// RESPONSE: 200 with a structured summary of every decision made (parse
// output, AC action, recency outcome, call lookup result). Always 200 if
// the request was well-formed and authenticated — pipeline failures are
// reported in the body so the human running the test can read what
// happened.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { extractQuoteFromPdf, ExtractedQuote } from '../../../../lib/quote-extraction'
import { resolveContactForCall } from '../../../../lib/activecampaign'
import { applyQuoteRecencyRule } from '../../../../lib/activecampaign-deals'
import { getQuoteCallContext } from '../../../../lib/quote-call-context'
import { getAgentByMailbox, listConfiguredMailboxes } from '../../../../lib/agents'

// PDF upload max size: Vercel default body parser is 1 MB. Bump to 10 MB.
// Mechanics Desk quotes are small (1-3 pages, ~50-300KB) so this is plenty.
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
  maxDuration: 60,                    // PDF parse + AC contact + AC deals + call lookup ~ 10-20s typical
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

  // ── Auth (URL secret) ───────────────────────────────────────────────
  const expected = process.env.QUOTE_STUB_SECRET
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'QUOTE_STUB_SECRET not configured' })
  }
  if (((req.query.key as string) || '') !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  // ── Validate body ───────────────────────────────────────────────────
  const body: RequestBody = req.body || {}
  const agentEmail = (body.agentEmail || '').trim()
  const pdfBase64 = (body.pdfBase64 || '').trim()
  const pdfFilename = body.pdfFilename || null

  if (!agentEmail) {
    return res.status(400).json({ ok: false, error: 'Missing agentEmail in body' })
  }
  if (!pdfBase64) {
    return res.status(400).json({ ok: false, error: 'Missing pdfBase64 in body' })
  }

  // ── 1. Resolve agent ───────────────────────────────────────────────
  const agent = getAgentByMailbox(agentEmail)
  if (!agent) {
    await logEvent({
      agentEmail,
      pdfFilename,
      action: 'failed',
      status: 'failed',
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

  // ── 2. Parse the PDF via Claude ────────────────────────────────────
  let extracted: ExtractedQuote
  let parseDurationMs = 0
  try {
    const tParse = Date.now()
    const result = await extractQuoteFromPdf(pdfBase64)
    parseDurationMs = Date.now() - tParse
    extracted = result.quote
  } catch (e: any) {
    await logEvent({
      agentEmail,
      pdfFilename,
      action: 'failed',
      status: 'failed',
      detailsExtra: { where: 'extractQuoteFromPdf', error: e?.message || String(e) },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false,
      stage: 'parse',
      error: e?.message || String(e),
    })
  }

  // ── 3. Resolve AC contact ──────────────────────────────────────────
  // Build a who_what string from the parsed PDF so the AC layer's name
  // parser can pick out firstName/lastName the same way it does for calls.
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
      agentEmail,
      pdfFilename,
      action: 'failed',
      status: 'failed',
      detailsExtra: {
        where: 'resolveContactForCall',
        error: e?.message || String(e),
        parsed: previewableQuote(extracted),
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false,
      stage: 'ac_contact_resolve',
      error: e?.message || String(e),
      parsed: previewableQuote(extracted),
    })
  }

  if (!acResolve.contact) {
    await logEvent({
      agentEmail,
      pdfFilename,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      action: 'skipped',
      status: 'partial',
      detailsExtra: {
        where: 'ac_contact_resolve',
        reason: acResolve.reason,
        action: acResolve.action,
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false,
      stage: 'ac_contact_resolve',
      reason: acResolve.reason,
      parsed: previewableQuote(extracted),
    })
  }

  // ── 4. Look up most recent call summary (best-effort) ──────────────
  // Pipeline A wanted single-call view per Q1 of the kickoff. The shared
  // helper is currently combined-multi-call (rebuilt for Pipeline B). So
  // for now the AC deal note will get the combined narrative; we'll add
  // a single-call helper later if it proves too verbose. Best-effort —
  // null is fine.
  let callContext: Awaited<ReturnType<typeof getQuoteCallContext>> = null
  if (extracted.customer.phone) {
    try {
      callContext = await getQuoteCallContext(extracted.customer.phone)
    } catch (e: any) {
      console.warn('[graph-mail/test] call context lookup failed (non-fatal):', e?.message || e)
    }
  }

  // ── 5. Apply the 30-day recency rule on AC deals ──────────────────
  // PREVIEW MODE: AC_DEAL_PREVIEW_ONLY=true (recommended for testing) makes
  // this log the decision + payload without writing.
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
      agentEmail,
      pdfFilename,
      customerEmail: extracted.customer.email,
      customerPhone: extracted.customer.phone,
      acContactId: acResolve.contact.id,
      action: 'failed',
      status: 'failed',
      detailsExtra: {
        where: 'applyQuoteRecencyRule',
        error: e?.message || String(e),
        parsed: previewableQuote(extracted),
      },
      durationMs: Date.now() - t0,
    })
    return res.status(200).json({
      ok: false,
      stage: 'ac_deal_recency',
      error: e?.message || String(e),
      parsed: previewableQuote(extracted),
      acContact: { id: acResolve.contact.id, action: acResolve.action },
    })
  }

  // ── 6. Log success ─────────────────────────────────────────────────
  // Translate Pipeline A's outcomes into quote_events.ac_action. Note that
  // 'contact_created' / 'contact_updated' apply to the contact step;
  // 'deal_created' / 'deal_updated' apply to the recency step. We use the
  // most-significant write that happened.
  const acActionForLog =
    recencyResult.preview ? 'skipped'
    : recencyResult.decision.action === 'create' ? 'deal_created'
    : 'deal_updated'

  await logEvent({
    agentEmail,
    pdfFilename,
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
    action: 'summary_posted',          // legacy quote_events shape; ok for stub
    status: recencyResult.preview ? 'partial' : 'success',
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
    },
    durationMs: Date.now() - t0,
  })

  // ── Response — full breakdown so the human running the test can audit ─
  return res.status(200).json({
    ok: true,
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
    monday: {
      note: 'Pipeline A Monday match-and-update is not wired in stub mode yet. Coming next session.',
    },
  })
}

// ── Helpers ────────────────────────────────────────────────────────────

function buildWhoWhatFromQuote(q: ExtractedQuote): string {
  // resolveContactForCall's name parser stops at words like " with ", " calling "
  // — so we frame the customer name first, vehicle next.
  const name = [q.customer.firstName, q.customer.lastName].filter(Boolean).join(' ')
    || q.customer.name
    || 'Unknown caller'
  const vehiclePart = q.vehicle.makeModel
    ? ` with a ${q.vehicle.makeModel}`
    : ''
  return `${name}${vehiclePart} regarding quote ${q.quote.number}`
}

function ownerIdFromAgentName(agentName: string): number | null {
  // Resolve through the same env-var map lib/activecampaign.ts uses, so
  // we don't have to expose its internal helper. Inline lookup here.
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
  // Trim line items in logs to avoid bloating quote_events. First 5 only.
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

// ── Audit logger ──────────────────────────────────────────────────────

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

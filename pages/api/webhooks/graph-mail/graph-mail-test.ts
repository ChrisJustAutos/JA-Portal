// pages/api/webhooks/graph-mail/graph-mail-test.ts
// Pipeline A — STUB-MODE endpoint for end-to-end testing without Microsoft Graph.
//
// TEMPORARILY ENHANCED with auth diagnostics (29 Apr 2026) to debug a 401
// situation where the URL secret appears correct but auth keeps failing.
// The auth-fail response now includes lengths + first/last chars of both
// the expected secret and the received key. Once the issue is identified
// and fixed, REMOVE the diagnostic block (search 'AUTH_DIAG' to find it).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { extractQuoteFromPdf, ExtractedQuote } from '../../../../lib/quote-extraction'
import { resolveContactForCall } from '../../../../lib/activecampaign'
import { applyQuoteRecencyRule } from '../../../../lib/activecampaign-deals'
import { getQuoteCallContext } from '../../../../lib/quote-call-context'
import { getAgentByMailbox, listConfiguredMailboxes } from '../../../../lib/agents'

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
    return res.status(500).json({
      ok: false,
      error: 'QUOTE_STUB_SECRET not configured',
      diag: {
        envVarPresent: false,
        gotLength: got.length,
      },
    })
  }

  if (got !== expected) {
    // AUTH_DIAG — show LENGTHS and FIRST/LAST 4 CHARS of both sides so we
    // can compare without exposing the full secret in the response.
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized',
      diag: {
        envVarPresent: true,
        expectedLength: expected.length,
        expectedFirst4: expected.substring(0, 4),
        expectedLast4: expected.substring(expected.length - 4),
        gotLength: got.length,
        gotFirst4: got.substring(0, 4),
        gotLast4: got.substring(got.length - 4),
        match: got === expected,
        // Invisible whitespace check on env var (known cause)
        expectedFirstCharCode: expected.charCodeAt(0),
        expectedLastCharCode: expected.charCodeAt(expected.length - 1),
      },
    })
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
    action: 'summary_posted',
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

function buildWhoWhatFromQuote(q: ExtractedQuote): string {
  const name = [q.customer.firstName, q.customer.lastName].filter(Boolean).join(' ')
    || q.customer.name
    || 'Unknown caller'
  const vehiclePart = q.vehicle.makeModel
    ? ` with a ${q.vehicle.makeModel}`
    : ''
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

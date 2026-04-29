// lib/activecampaign-deals.ts
// ActiveCampaign DEAL operations for Pipeline A (quote ingestion).
//
// Separate file from lib/activecampaign.ts on purpose:
//   - That file owns CONTACT operations (resolve, note, tag) and is in
//     production via the follow-up sync cron. Keep it untouched.
//   - This file owns DEAL operations — create, update, deal-note, plus
//     the recency rule that decides between create-vs-update for an
//     incoming quote.
//
// THE RECENCY RULE (per design doc §7):
//
//   Search AC for deals on this contact:
//
//     IF an OPEN deal exists (not Won, not Lost)
//        AND deal_created_at within last 30 days:
//          → UPDATE that deal
//          → AC's automation does NOT fire (only deal-create fires it)
//
//     ELSE:
//          → CREATE a new deal
//          → AC automation fires → webhook → Make → Monday lead created
//
// The create-vs-update decision is the lever that controls whether Make
// creates a new Monday lead. Pipeline A intentionally does NOT touch
// Monday on the create branch — Make handles it.
//
// PREVIEW MODE:
//   Set AC_DEAL_PREVIEW_ONLY=true in env to log what we WOULD do without
//   actually creating/updating. The recency-rule decision is fully
//   computed and visible in the result, but no AC writes happen. Use
//   during stub-mode validation before going live.
//
// ENV VARS NEEDED:
//   ACTIVECAMPAIGN_API_URL              shared with lib/activecampaign.ts
//   ACTIVECAMPAIGN_API_KEY              shared with lib/activecampaign.ts
//   AC_QUOTE_PIPELINE_ID                AC pipeline ID where new quote deals land
//                                       (the pipeline whose automation fires
//                                       the Make webhook). To be confirmed at
//                                       build time per design §15.
//   AC_QUOTE_PIPELINE_STAGE_ID          AC stage ID within that pipeline (the
//                                       stage that triggers the automation).
//                                       Also TBC at build time.
//   AC_DEAL_PREVIEW_ONLY                'true' to dry-run all writes.

const RECENCY_DAYS = 30

function acFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('ACTIVECAMPAIGN_API_URL and ACTIVECAMPAIGN_API_KEY must be set')
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/3${path}`
  const headers = {
    'Api-Token': apiKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(opts.headers || {}),
  }
  return fetch(url, { ...opts, headers })
}

async function acJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await acFetch(path, opts)
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`AC deals API ${r.status} on ${path}: ${errText.substring(0, 500)}`)
  }
  return r.json()
}

function isPreviewOnly(): boolean {
  return (process.env.AC_DEAL_PREVIEW_ONLY || '').toLowerCase() === 'true'
}

// ── Deal type ──────────────────────────────────────────────────────────
// AC deal status values (numeric):
//   0 = Open
//   1 = Won
//   2 = Lost
// Reference: AC API v3 docs.
const DEAL_STATUS_OPEN = 0
const DEAL_STATUS_WON  = 1
const DEAL_STATUS_LOST = 2

export interface ACDeal {
  id: number
  title: string
  value: number               // dollars (AC stores cents — we convert)
  status: 0 | 1 | 2
  stageId: number | null
  pipelineId: number | null
  ownerId: number | null
  contactId: number
  createdAt: string           // ISO from AC's `cdate`
}

function mapDeal(raw: any): ACDeal {
  // AC's `value` is in cents as a string. Defensive parse.
  const valueCents = Number(raw.value || 0)
  return {
    id: Number(raw.id),
    title: String(raw.title || ''),
    value: Number.isFinite(valueCents) ? valueCents / 100 : 0,
    status: Number(raw.status) as 0 | 1 | 2,
    stageId: raw.stage ? Number(raw.stage) : null,
    pipelineId: raw.group ? Number(raw.group) : null,
    ownerId: raw.owner ? Number(raw.owner) : null,
    contactId: Number(raw.contact),
    createdAt: String(raw.cdate || ''),
  }
}

// ── Search: deals for a contact ────────────────────────────────────────
//
// AC's `/deals?filters[contact]=NN` returns deals for that contact.
// We pull recent ones and let the recency rule filter further in code.

export async function listDealsForContact(contactId: number, limit = 20): Promise<ACDeal[]> {
  const data = await acJson<{ deals: any[] }>(
    `/deals?filters[contact]=${contactId}&orders[cdate]=DESC&limit=${limit}`,
  )
  return (data.deals || []).map(mapDeal)
}

// ── Recency rule decision (no writes) ──────────────────────────────────

export type RecencyDecision =
  | { action: 'update'; deal: ACDeal; reason: string }
  | { action: 'create'; reason: string }

export function decideRecencyAction(deals: ACDeal[]): RecencyDecision {
  const cutoff = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000

  // Find the most recent OPEN deal within the window.
  // Won/Lost deals never get reopened — repeat business is a new deal.
  const recentOpen = deals.find(d => {
    if (d.status !== DEAL_STATUS_OPEN) return false
    const created = new Date(d.createdAt).getTime()
    if (!Number.isFinite(created)) return false
    return created >= cutoff
  })

  if (recentOpen) {
    return {
      action: 'update',
      deal: recentOpen,
      reason: `existing open deal #${recentOpen.id} created within ${RECENCY_DAYS} days`,
    }
  }

  return {
    action: 'create',
    reason: deals.length === 0
      ? 'no existing deals'
      : 'no open deal within 30 days (or only Won/Lost / older)',
  }
}

// ── Create deal ────────────────────────────────────────────────────────

export interface CreateDealInput {
  contactId: number
  title: string                  // e.g. 'Q12345 · Toyota LandCruiser 300 · ABC123'
  valueDollarsIncGst: number     // We convert to cents internally
  ownerId: number | null         // From ACTIVECAMPAIGN_OWNER_MAP via agentName
  pipelineId?: number            // Defaults to AC_QUOTE_PIPELINE_ID env
  stageId?: number               // Defaults to AC_QUOTE_PIPELINE_STAGE_ID env
  initialNote?: string | null    // Posted as the first deal note
  // Custom fields TBD at build time per design §15. Accept arbitrary
  // map for forward compatibility.
  customFields?: Array<{ fieldId: number; value: string }>
}

export interface CreateDealResult {
  dealId: number | null          // null when in preview mode
  noteId: number | null
  preview: boolean
  payload: any                   // What we sent (or would have sent)
}

export async function createDeal(input: CreateDealInput): Promise<CreateDealResult> {
  const pipelineId = input.pipelineId ?? Number(process.env.AC_QUOTE_PIPELINE_ID || 0)
  const stageId = input.stageId ?? Number(process.env.AC_QUOTE_PIPELINE_STAGE_ID || 0)
  if (!pipelineId || !stageId) {
    throw new Error('AC_QUOTE_PIPELINE_ID and AC_QUOTE_PIPELINE_STAGE_ID must be set (or passed explicitly)')
  }

  const payload: any = {
    deal: {
      title: input.title,
      value: Math.round(input.valueDollarsIncGst * 100),  // cents
      currency: 'AUD',
      contact: input.contactId,
      group: pipelineId,           // AC calls pipelines "groups" in this endpoint
      stage: stageId,
      status: DEAL_STATUS_OPEN,
    },
  }
  if (input.ownerId) payload.deal.owner = input.ownerId
  if (input.customFields && input.customFields.length > 0) {
    payload.dealCustomFieldData = input.customFields.map(f => ({
      customFieldId: f.fieldId,
      fieldValue: f.value,
    }))
  }

  if (isPreviewOnly()) {
    console.log('[ac-deals] PREVIEW: would create deal', JSON.stringify(payload))
    return { dealId: null, noteId: null, preview: true, payload }
  }

  const created = await acJson<{ deal: any }>(`/deals`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  const dealId = Number(created.deal.id)

  let noteId: number | null = null
  if (input.initialNote) {
    noteId = await addDealNote(dealId, input.initialNote)
  }

  return { dealId, noteId, preview: false, payload }
}

// ── Update deal ────────────────────────────────────────────────────────

export interface UpdateDealInput {
  dealId: number
  // Fields we update on a quote-update event:
  //   - title:  append the new quote number to the title (caller decides format)
  //   - value:  max(existing, new) — caller passes the new total; AC takes it
  //   - note:   append a fresh deal note describing the new quote
  newTitle?: string
  newValueDollarsIncGst?: number
  appendNote?: string | null
  customFields?: Array<{ fieldId: number; value: string }>
}

export interface UpdateDealResult {
  dealId: number
  noteId: number | null
  preview: boolean
  payload: any
}

export async function updateDeal(input: UpdateDealInput): Promise<UpdateDealResult> {
  const payload: any = { deal: {} }
  if (input.newTitle !== undefined) payload.deal.title = input.newTitle
  if (input.newValueDollarsIncGst !== undefined) {
    payload.deal.value = Math.round(input.newValueDollarsIncGst * 100)
    payload.deal.currency = 'AUD'
  }
  if (input.customFields && input.customFields.length > 0) {
    payload.dealCustomFieldData = input.customFields.map(f => ({
      customFieldId: f.fieldId,
      fieldValue: f.value,
    }))
  }

  if (isPreviewOnly()) {
    console.log(`[ac-deals] PREVIEW: would update deal ${input.dealId}`, JSON.stringify(payload))
    return { dealId: input.dealId, noteId: null, preview: true, payload }
  }

  // Only call PUT if we actually have something to update — otherwise just
  // do the note (AC complains about empty PUT bodies).
  const hasFieldUpdates = Object.keys(payload.deal).length > 0 || (payload.dealCustomFieldData?.length || 0) > 0
  if (hasFieldUpdates) {
    await acJson(`/deals/${input.dealId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
  }

  let noteId: number | null = null
  if (input.appendNote) {
    noteId = await addDealNote(input.dealId, input.appendNote)
  }

  return { dealId: input.dealId, noteId, preview: false, payload }
}

// ── Deal note ──────────────────────────────────────────────────────────
// Deal notes attach via reltype='Deal' (different from contact notes).

async function addDealNote(dealId: number, body: string): Promise<number | null> {
  if (isPreviewOnly()) {
    console.log(`[ac-deals] PREVIEW: would add note to deal ${dealId}: ${body.substring(0, 80)}...`)
    return null
  }
  try {
    const data = await acJson<{ note: { id: string } }>(`/notes`, {
      method: 'POST',
      body: JSON.stringify({
        note: {
          note: body,
          relid: dealId,
          reltype: 'Deal',
        },
      }),
    })
    return Number(data.note.id)
  } catch (e: any) {
    console.warn(`[ac-deals] failed to add note to deal ${dealId}:`, e?.message)
    return null
  }
}

// ── High-level orchestrator: apply the recency rule for a parsed quote ──
//
// One call to do the full decide → write → return for Pipeline A's
// AC-side work. Caller (the Pipeline A worker) provides the parsed quote
// + the resolved contact + the rep's owner ID, and gets back a result
// describing what happened.

export interface ApplyQuoteRecencyInput {
  contactId: number
  agentName: string                       // For deal title attribution / logging
  ownerId: number | null                  // Resolved via ACTIVECAMPAIGN_OWNER_MAP
  // Parsed quote shape (matches lib/quote-extraction.ts ExtractedQuote)
  quoteNumber: string
  totalIncGst: number | null              // Required for value field — fall back to ex+gst if needed
  totalExGst: number | null
  vehicleMakeModel: string | null
  vehicleRego: string | null
  callContextNote: string | null          // Optional: pre-rendered call summary text
}

export interface ApplyQuoteRecencyResult {
  decision: RecencyDecision
  dealId: number | null
  noteId: number | null
  preview: boolean
  // Telemetry for logging into quote_events
  details: {
    existingDealsCount: number
    chosenDealId: number | null
    chosenDealCreatedAt: string | null
  }
}

export async function applyQuoteRecencyRule(
  input: ApplyQuoteRecencyInput,
): Promise<ApplyQuoteRecencyResult> {
  const deals = await listDealsForContact(input.contactId)
  const decision = decideRecencyAction(deals)

  // Compute the deal value: prefer inc-GST, fall back to ex-GST.
  const dealValue = input.totalIncGst != null
    ? input.totalIncGst
    : (input.totalExGst != null ? input.totalExGst * 1.1 : 0)

  // Title format: "Q{number} · {makeModel} · {rego}" with sensible fallbacks.
  const titleParts: string[] = [`Q${input.quoteNumber}`]
  if (input.vehicleMakeModel) titleParts.push(input.vehicleMakeModel)
  if (input.vehicleRego) titleParts.push(input.vehicleRego)
  const fullTitle = titleParts.join(' · ')

  // Note body: quote details + optional call context.
  const noteLines: string[] = [
    `Quote ${input.quoteNumber} sent ${new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' })}`,
    `Value: $${dealValue.toFixed(2)} inc GST`,
  ]
  if (input.vehicleMakeModel) noteLines.push(`Vehicle: ${input.vehicleMakeModel}${input.vehicleRego ? ` (${input.vehicleRego})` : ''}`)
  noteLines.push(`Rep: ${input.agentName}`)
  if (input.callContextNote) {
    noteLines.push('', '── Call context ──', input.callContextNote)
  }
  const noteBody = noteLines.join('\n')

  if (decision.action === 'create') {
    const result = await createDeal({
      contactId: input.contactId,
      title: fullTitle,
      valueDollarsIncGst: dealValue,
      ownerId: input.ownerId,
      initialNote: noteBody,
    })
    return {
      decision,
      dealId: result.dealId,
      noteId: result.noteId,
      preview: result.preview,
      details: {
        existingDealsCount: deals.length,
        chosenDealId: null,
        chosenDealCreatedAt: null,
      },
    }
  }

  // Update branch
  const existing = decision.deal
  // value: keep the higher of existing vs new (don't accidentally lower
  // a deal value if the latest quote is smaller — that would lose data).
  const newValue = Math.max(existing.value, dealValue)
  // Title: append the new quote number if not already present.
  const newTitle = existing.title.includes(`Q${input.quoteNumber}`)
    ? existing.title
    : `${existing.title} | Q${input.quoteNumber}`

  const result = await updateDeal({
    dealId: existing.id,
    newTitle,
    newValueDollarsIncGst: newValue,
    appendNote: noteBody,
  })
  return {
    decision,
    dealId: result.dealId,
    noteId: result.noteId,
    preview: result.preview,
    details: {
      existingDealsCount: deals.length,
      chosenDealId: existing.id,
      chosenDealCreatedAt: existing.createdAt,
    },
  }
}

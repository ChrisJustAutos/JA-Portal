// lib/activecampaign-deals.ts
// ActiveCampaign DEAL operations for Pipeline A (quote ingestion).
//
// REWRITTEN 29 Apr 2026 (round 3) — Zapier replacement architecture:
//
//   Pipeline A creates deals directly at the "Quote Sent" stage. The
//   previous Zapier zap (Outlook → PDF.co → AC → Monday) is being retired;
//   Pipeline A owns this entire flow now.
//
//   Make is unaffected: it still fires on stage 35 ("Quote Required") for
//   genuine initial enquiries created by other paths (web forms, manual
//   entry). Pipeline A skips stage 35 entirely so Make never sees these
//   quote-driven deals.
//
//   The dual-stage 35→38 advance machinery from the previous patch round
//   is removed — it was solving the wrong problem (firing Zapier).
//
// Recency rule unchanged:
//   - Find any OPEN deal (status=0) for this contact created in the last
//     30 days → UPDATE that deal.
//   - Otherwise CREATE a new deal at stage 38 ("Quote Sent").
//   - Won/Lost deals are excluded from the recency check, so a repeat
//     customer who closed a deal 6 months ago gets a fresh deal.
//
// AC API quirks (round 1 patch):
//   - pipeline_id, stage_id, contact_id, owner must be sent as STRINGS,
//     not numbers. Numeric values trigger 422 "stage is not part of pipeline".
//   - currency must be lowercase ('aud' not 'AUD') to match what the
//     pipeline stores.

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

const DEAL_STATUS_OPEN = 0

export interface ACDeal {
  id: number
  title: string
  value: number
  status: 0 | 1 | 2
  stageId: number | null
  pipelineId: number | null
  ownerId: number | null
  contactId: number
  createdAt: string
}

function mapDeal(raw: any): ACDeal {
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

export async function listDealsForContact(contactId: number, limit = 20): Promise<ACDeal[]> {
  const data = await acJson<{ deals: any[] }>(
    `/deals?filters[contact]=${contactId}&orders[cdate]=DESC&limit=${limit}`,
  )
  return (data.deals || []).map(mapDeal)
}

export type RecencyDecision =
  | { action: 'update'; deal: ACDeal; reason: string }
  | { action: 'create'; reason: string }

export function decideRecencyAction(deals: ACDeal[]): RecencyDecision {
  const cutoff = Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000

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

export interface CreateDealInput {
  contactId: number
  title: string
  valueDollarsIncGst: number
  ownerId: number | null
  pipelineId?: number
  stageId?: number
  initialNote?: string | null
  customFields?: Array<{ fieldId: number; value: string }>
}

export interface CreateDealResult {
  dealId: number | null
  noteId: number | null
  preview: boolean
  payload: any
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
      value: Math.round(input.valueDollarsIncGst * 100),
      currency: 'aud',
      contact: String(input.contactId),
      group: String(pipelineId),
      stage: String(stageId),
      status: DEAL_STATUS_OPEN,
    },
  }
  if (input.ownerId) payload.deal.owner = String(input.ownerId)
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

export interface UpdateDealInput {
  dealId: number
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
    payload.deal.currency = 'aud'
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

export interface ApplyQuoteRecencyInput {
  contactId: number
  agentName: string
  ownerId: number | null
  quoteNumber: string
  totalIncGst: number | null
  totalExGst: number | null
  vehicleMakeModel: string | null
  vehicleRego: string | null
  callContextNote: string | null
}

export interface ApplyQuoteRecencyResult {
  decision: RecencyDecision
  dealId: number | null
  noteId: number | null
  preview: boolean
  details: {
    existingDealsCount: number
    chosenDealId: number | null
    chosenDealCreatedAt: string | null
    landedAtStageId: number | null    // The AC stage the deal ended up at after this run
  }
}

export async function applyQuoteRecencyRule(
  input: ApplyQuoteRecencyInput,
): Promise<ApplyQuoteRecencyResult> {
  const targetStageId = Number(process.env.AC_QUOTE_PIPELINE_STAGE_ID || 0)

  const deals = await listDealsForContact(input.contactId)
  const decision = decideRecencyAction(deals)

  const dealValue = input.totalIncGst != null
    ? input.totalIncGst
    : (input.totalExGst != null ? input.totalExGst * 1.1 : 0)

  const titleParts: string[] = [`Q${input.quoteNumber}`]
  if (input.vehicleMakeModel) titleParts.push(input.vehicleMakeModel)
  if (input.vehicleRego) titleParts.push(input.vehicleRego)
  const fullTitle = titleParts.join(' · ')

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
    // CREATE branch: land directly at the configured stage (= 38 "Quote Sent").
    // No Make involvement (Make listens at stage 35), no Zapier (we're
    // replacing that). Single API call.
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
        landedAtStageId: targetStageId || null,
      },
    }
  }

  // UPDATE branch: existing recent open deal exists. Update fields but
  // DON'T touch the stage — the rep may have moved it elsewhere on
  // purpose (e.g. follow-up tracking). The original Zapier flow also
  // didn't change stage on update, so this matches existing behaviour.
  const existing = decision.deal
  const newValue = Math.max(existing.value, dealValue)
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
      landedAtStageId: existing.stageId,
    },
  }
}

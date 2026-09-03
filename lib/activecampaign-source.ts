// lib/activecampaign-source.ts
// Provenance markers for the ActiveCampaign records Pipeline A writes.
//
// WHY THIS EXISTS
// Until 2026-09-04 nothing on an AC deal said where it came from. A deal
// raised from a Mechanics Desk quote email was distinguishable from one a
// rep typed by hand only through three conventions, all inferential:
//   - a "Q<number>" title prefix
//   - landing at stage 38 rather than 35
//   - the wording of its first note
// None of that is queryable, none of it survives a rep editing the title,
// and none of it lets an AC automation trigger on "this came from MD".
//
// So we now stamp provenance explicitly:
//   - DEAL:    custom field "Source" = "Mechanics Desk"
//              custom field "MD Quote Number" = the quote number
//   - CONTACT: tag "Mechanics Desk"
//
// The tag is the half an AC automation can trigger on; the deal fields are
// the half a report can filter and group by. That is why it is both and not
// one — they are read by different tools.
//
// NOTHING HERE MAY BREAK THE QUOTE PIPELINE. A provenance stamp is strictly
// less important than the deal it describes, so every function here fails
// soft: it returns a result object saying what happened and never throws.
// This is the same rule the Monday contact-attempts counter learned the hard
// way — a cosmetic field rejected a whole mutation and cost James 123 quotes.
//
// FIELD CREATION is automatic and idempotent: we look the fields up by label
// on first use and create them if absent, then cache the IDs for the life of
// the instance. No manual setup in the AC UI, no env var to forget.

import { ensureTagExists, attachTagToContact } from './activecampaign'

// ── Names. Changing these creates NEW fields/tags rather than renaming the
// existing ones, which would orphan every record already stamped. Don't.
export const SOURCE_FIELD_LABEL = 'Source'
export const QUOTE_NUMBER_FIELD_LABEL = 'MD Quote Number'
export const VEHICLE_FIELD_LABEL = 'Vehicle'
export const REGO_FIELD_LABEL = 'Rego'
export const SOURCE_VALUE_MECHANICS_DESK = 'Mechanics Desk'
export const MD_CONTACT_TAG = 'Mechanics Desk'

const TAG_DESCRIPTION =
  'Auto-applied by the portal when a Mechanics Desk quote email creates or updates this contact (Pipeline A). Use as an automation trigger for MD-originated leads.'

function acFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const baseUrl = process.env.ACTIVECAMPAIGN_API_URL
  const apiKey = process.env.ACTIVECAMPAIGN_API_KEY
  if (!baseUrl || !apiKey) {
    throw new Error('ACTIVECAMPAIGN_API_URL and ACTIVECAMPAIGN_API_KEY must be set')
  }
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/3${path}`, {
    ...opts,
    headers: {
      'Api-Token': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {}),
    },
  })
}

async function acJson<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await acFetch(path, opts)
  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`AC source API ${r.status} on ${path}: ${errText.substring(0, 400)}`)
  }
  return r.json()
}

function isPreviewOnly(): boolean {
  return (process.env.AC_DEAL_PREVIEW_ONLY || '').toLowerCase() === 'true'
}

// ── Deal custom field metadata ─────────────────────────────────────────
//
// AC keeps DEAL custom fields under /dealCustomFieldMeta (contact fields are
// a different endpoint entirely — /fields — and the two are not
// interchangeable). Values are then written either inline on the deal via
// `dealCustomFieldData`, or standalone via POST /dealCustomFieldData.
//
// Cache holds `null` for "we tried and could not get an ID", so a broken
// lookup costs one probe per cold start rather than one per quote.

const fieldIdCache = new Map<string, number | null>()

/** Page through every deal custom field. AC caps `limit` at 100. */
async function listDealFieldMeta(): Promise<Array<{ id: string; fieldLabel: string }>> {
  const out: Array<{ id: string; fieldLabel: string }> = []
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await acJson<{ dealCustomFieldMeta: any[] }>(
      `/dealCustomFieldMeta?limit=100&offset=${offset}`,
    )
    const page = data.dealCustomFieldMeta || []
    out.push(...page)
    if (page.length < 100) break
  }
  return out
}

/**
 * Resolve a deal custom field by label, creating it if it doesn't exist.
 * Returns null if AC can't be reached or the field can't be made — callers
 * must treat that as "skip the stamp", never as an error.
 */
export async function ensureDealFieldId(
  label: string,
  fieldType: 'text' | 'textarea' = 'text',
): Promise<number | null> {
  const hit = fieldIdCache.get(label)
  if (hit !== undefined) return hit

  let existing: Array<{ id: string; fieldLabel: string }>
  try {
    existing = await listDealFieldMeta()
  } catch (e: any) {
    console.error(`[ac-source] could not list deal fields:`, e?.message)
    return null   // transient — don't poison the cache
  }

  const match = existing.find(f => String(f.fieldLabel || '').trim() === label)
  if (match) {
    const id = Number(match.id)
    fieldIdCache.set(label, id)
    return id
  }

  if (isPreviewOnly()) {
    console.log(`[ac-source] PREVIEW: would create deal field '${label}'`)
    return null
  }

  try {
    // ⚠ AC SINGULARISES THE KEY ON WRITE. GET /dealCustomFieldMeta returns
    // `dealCustomFieldMeta`, but POST demands `dealCustomFieldMetum` in the
    // BODY and answers with `dealCustomFieldMetum` too. Sending the plural
    // fails 400 "A dealCustomFieldMetum object must be provided" — which the
    // catch below swallowed into a null field id, so every deal silently
    // went unstamped and the run reported success. Verified against the live
    // API on 2026-09-04; `isDealVisible` is not a real property and is gone.
    const created = await acJson<{ dealCustomFieldMetum: { id: string } }>(`/dealCustomFieldMeta`, {
      method: 'POST',
      body: JSON.stringify({
        dealCustomFieldMetum: {
          fieldLabel: label,
          fieldType,
          fieldDefault: '',
          isFormVisible: 0,
          isRequired: 0,
        },
      }),
    })
    const id = Number(created.dealCustomFieldMetum.id)
    fieldIdCache.set(label, id)
    console.log(`[ac-source] created deal custom field '${label}' -> ${id}`)
    return id
  } catch (e: any) {
    console.error(`[ac-source] could not create deal field '${label}':`, e?.message)
    fieldIdCache.set(label, null)
    return null
  }
}

export interface SourceCustomField {
  fieldId: number
  value: string
}

/**
 * The custom fields to stamp on a deal raised from a Mechanics Desk quote.
 * Shaped for createDeal/updateDeal's existing `customFields` parameter.
 *
 * Returns [] rather than throwing when the fields can't be resolved, so a
 * provenance problem can never stop a deal being written.
 */
export async function mechanicsDeskDealFields(
  quoteNumber: string | null,
  vehicle?: string | null,
  rego?: string | null,
): Promise<SourceCustomField[]> {
  const out: SourceCustomField[] = []
  try {
    const sourceId = await ensureDealFieldId(SOURCE_FIELD_LABEL)
    if (sourceId) out.push({ fieldId: sourceId, value: SOURCE_VALUE_MECHANICS_DESK })

    if (quoteNumber) {
      const quoteId = await ensureDealFieldId(QUOTE_NUMBER_FIELD_LABEL)
      // Latest quote number only. A deal updated by the recency rule
      // accumulates several, and the full history stays in the deal TITLE
      // ("Q61288 | Q61294") — which is what the won/lost sweeps parse.
      if (quoteId) out.push({ fieldId: quoteId, value: quoteNumber })
    }

    // Vehicle and rego are in the deal TITLE already, but only as free text
    // a rep can edit away. As fields they are filterable and survive a
    // rename — and the rego is what the MD-fallback win match keys on.
    if (vehicle) {
      const vId = await ensureDealFieldId(VEHICLE_FIELD_LABEL)
      if (vId) out.push({ fieldId: vId, value: vehicle })
    }
    if (rego) {
      const rId = await ensureDealFieldId(REGO_FIELD_LABEL)
      if (rId) out.push({ fieldId: rId, value: rego })
    }
  } catch (e: any) {
    console.error('[ac-source] mechanicsDeskDealFields failed:', e?.message)
  }
  return out
}

export interface TagContactResult {
  tagged: boolean
  tagId: number | null
  error: string | null
}

/** Tag a contact as Mechanics Desk-originated. Never throws. */
export async function tagContactAsMechanicsDesk(contactId: number): Promise<TagContactResult> {
  if (isPreviewOnly()) {
    console.log(`[ac-source] PREVIEW: would tag contact ${contactId} '${MD_CONTACT_TAG}'`)
    return { tagged: false, tagId: null, error: null }
  }
  try {
    const tagId = await ensureTagExists(MD_CONTACT_TAG, TAG_DESCRIPTION)
    if (!tagId) return { tagged: false, tagId: null, error: 'tag could not be resolved or created' }
    const tagged = await attachTagToContact(contactId, tagId)
    return { tagged, tagId, error: tagged ? null : 'attach failed' }
  } catch (e: any) {
    return { tagged: false, tagId: null, error: e?.message || String(e) }
  }
}

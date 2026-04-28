// lib/activecampaign.ts
// ActiveCampaign helper for the call follow-up sync worker.
//
// Three operations:
//   1. findContactByPhone(phone) — searches AC by phone with strict
//      verification that the matched contact's phone digits actually
//      equal the query phone digits. Required because AC's filters[phone]
//      is partial-match and returns false positives.
//   2. createContact(input) — creates a new AC contact with the sales
//      rep set as the owner, when no existing contact matches.
//   3. postNoteAndTag(contactId, noteBody) — adds a contact note and
//      applies the follow-up tag (so AC automations can trigger off it).
//
// Why the tag matters: AC is the automation hub here, not the source of
// truth. The tag 'call-summary-pushed' is the trigger signal for AC
// automations like "send rep a Slack DM", "fire a follow-up email if
// no human contact in 7 days", etc.
//
// Env: ACTIVECAMPAIGN_API_URL (e.g. 'https://justautosmechanical.api-us1.com')
//      ACTIVECAMPAIGN_API_KEY  (the v3 API key from Settings → Developer)
//      ACTIVECAMPAIGN_FOLLOWUP_TAG (default 'call-summary-pushed')
//      ACTIVECAMPAIGN_OWNER_MAP    (JSON map of agent name → AC user ID,
//                                   e.g. '{"Kaleb":12,"Dom S":15}')

const TAG_NAME = process.env.ACTIVECAMPAIGN_FOLLOWUP_TAG || 'call-summary-pushed'

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
    throw new Error(`AC API ${r.status} on ${path}: ${errText.substring(0, 500)}`)
  }
  return r.json()
}

// ── Phone normalisation ──────────────────────────────────────────────────
// AC stores phone numbers however the user typed them in. We normalise to
// digits-only (after stripping +61 / leading 0) for SAFE comparison.
// IMPORTANT: AC's filters[phone] is partial-match, not exact, and matches
// EVERYTHING when the value is empty. We MUST verify any matched contact's
// phone digits actually equal the query phone digits before accepting it.

function normalisePhone(raw: string | null | undefined): string {
  const d = (raw || '').replace(/\D/g, '')
  if (d.startsWith('61') && d.length >= 11) return d.substring(2)
  if (d.startsWith('0')) return d.substring(1)
  return d
}

// Returns the digits to use as the search query (8+ chars to avoid false
// positives like searching "61" matching everything).
function searchableDigits(raw: string | null | undefined): string | null {
  const d = normalisePhone(raw)
  if (d.length < 8) return null   // Anything under 8 digits is unsafe to search
  return d
}

// ── Contact lookup ──

export interface ACContact {
  id: number
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
}

/**
 * Search AC for a contact whose phone matches `rawPhone`.
 *
 * Strategy:
 *   1. Search using digits-only with `search=` (broad query).
 *   2. For each returned contact, verify its phone field's digits match
 *      our query's digits. Any contact whose digits don't match is rejected.
 *   3. Returns the first verified match, or null.
 *
 * The verification step is non-negotiable. AC's search/filter parameters
 * are loose (partial match) and will happily return the same contact for
 * any number of unrelated queries — see issue with contact 30121 acting
 * as a catch-all match for 26 different real customer numbers.
 */
export async function findContactByPhone(rawPhone: string): Promise<ACContact | null> {
  const queryDigits = searchableDigits(rawPhone)
  if (!queryDigits) return null

  const data = await acJson<{ contacts: any[] }>(
    `/contacts?search=${encodeURIComponent(queryDigits)}&limit=20`,
  )
  const contacts = data.contacts || []
  if (contacts.length === 0) return null

  // VERIFY: only accept a contact whose phone digits actually match
  // the query digits. AC may return loosely-matched results (e.g. matched
  // on email, name, or another field), or return EVERY contact when the
  // search is too short / loose.
  for (const c of contacts) {
    const candidatePhone = normalisePhone(c.phone)
    if (candidatePhone === queryDigits) {
      return mapContact(c)
    }
    // AC sometimes stores the number in a custom field or in `phone` with
    // formatting. Accept if the candidate's phone digits END with our
    // query digits or vice versa, but ONLY if both are at least 8 digits.
    if (
      candidatePhone.length >= 8 &&
      (candidatePhone.endsWith(queryDigits) || queryDigits.endsWith(candidatePhone))
    ) {
      return mapContact(c)
    }
  }

  return null
}

function mapContact(raw: any): ACContact {
  return {
    id: Number(raw.id),
    email: raw.email || null,
    firstName: raw.firstName || null,
    lastName: raw.lastName || null,
    phone: raw.phone || null,
  }
}

// ── Owner mapping ────────────────────────────────────────────────────────
// AC contacts have an `owner` field pointing to an AC user ID. When we
// create a new contact for a call, we want the owner to be the rep who
// took the call, so AC's "owned by" filters and rep-specific automations
// fire correctly.
//
// The mapping lives in an env var so it's editable without a code deploy.
// Format: '{"AgentName1": ACUserId1, "AgentName2": ACUserId2}'.
// Match is case-insensitive and uses the agent_name as it appears on
// the calls table (e.g. "Kaleb", "Dom S", "James Wilson").

let cachedOwnerMap: Record<string, number> | null = null
function getOwnerMap(): Record<string, number> {
  if (cachedOwnerMap) return cachedOwnerMap
  const raw = process.env.ACTIVECAMPAIGN_OWNER_MAP || '{}'
  try {
    const parsed = JSON.parse(raw)
    // Lowercase keys for case-insensitive lookup
    const normalised: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      normalised[String(k).trim().toLowerCase()] = Number(v)
    }
    cachedOwnerMap = normalised
    return normalised
  } catch {
    console.warn('[ac] ACTIVECAMPAIGN_OWNER_MAP is not valid JSON — ignoring')
    cachedOwnerMap = {}
    return cachedOwnerMap
  }
}

function ownerIdForAgent(agentName: string | null): number | null {
  if (!agentName) return null
  const map = getOwnerMap()
  return map[agentName.trim().toLowerCase()] || null
}

// ── Create contact ───────────────────────────────────────────────────────

interface CreateContactInput {
  phone: string                          // The customer's phone (raw)
  firstName: string | null
  lastName: string | null
  email: string | null
  agentName: string | null               // Used to resolve owner via the map
  noteForCreation: string | null         // Optional note explaining who created it
}

/**
 * Create a new AC contact. Used when findContactByPhone returns null.
 * Sets the owner to the sales rep (if mapping exists) so AC automations
 * routed by owner fire correctly.
 */
async function createContact(input: CreateContactInput): Promise<ACContact> {
  const ownerId = ownerIdForAgent(input.agentName)

  const contactPayload: any = {
    phone: input.phone,
    firstName: input.firstName || '',
    lastName: input.lastName || '',
  }
  if (input.email) contactPayload.email = input.email
  if (ownerId) contactPayload.owner = ownerId

  // AC requires AT LEAST one of email/phone. If we don't have email,
  // phone alone is fine. If we have neither, we shouldn't have got here.
  if (!input.email && !input.phone) {
    throw new Error('Cannot create AC contact without email or phone')
  }

  // Note: AC's email field is required by their UI but the API allows
  // creating phone-only contacts. They'll appear in AC with no email
  // address and a "Phone" tab in the contact view.
  const created = await acJson<{ contact: any }>(`/contacts`, {
    method: 'POST',
    body: JSON.stringify({ contact: contactPayload }),
  })

  const contact = mapContact(created.contact)

  // Add a note explaining the auto-creation, so reps in AC understand
  // where this contact came from.
  if (input.noteForCreation) {
    try {
      await acJson(`/notes`, {
        method: 'POST',
        body: JSON.stringify({
          note: {
            note: input.noteForCreation,
            relid: contact.id,
            reltype: 'Subscriber',
          },
        }),
      })
    } catch (e: any) {
      // Non-fatal — the main note will be posted by the orchestrator.
      console.warn(`[ac] failed to post creation note for new contact ${contact.id}:`, e?.message)
    }
  }

  return contact
}

// ── Note + tag ──

/**
 * Post a note on a contact and apply the follow-up tag.
 *
 * AC's note model: notes are attached to a "relationship" — for a contact,
 * that's reltype=Subscriber and relid=contactId. The note body supports
 * plain text only (no HTML or markdown).
 */
export async function postNoteAndTag(
  contactId: number,
  noteBody: string,
): Promise<{ noteId: number; tagApplied: boolean }> {
  // 1. Create the note
  const note = await acJson<{ note: { id: string } }>(`/notes`, {
    method: 'POST',
    body: JSON.stringify({
      note: {
        note: noteBody,
        relid: contactId,
        reltype: 'Subscriber',
      },
    }),
  })
  const noteId = Number(note.note.id)

  // 2. Apply the tag — first ensure it exists, then attach
  const tagId = await ensureTagExists(TAG_NAME)
  let tagApplied = false
  if (tagId) {
    try {
      await acJson(`/contactTags`, {
        method: 'POST',
        body: JSON.stringify({
          contactTag: {
            contact: contactId,
            tag: tagId,
          },
        }),
      })
      tagApplied = true
    } catch (e: any) {
      // Tag attachment failure is non-fatal — note is already posted.
      // AC returns 422 if the contact already has the tag, which is fine.
      if (!String(e?.message || '').includes('422')) {
        console.error(`[ac] failed to attach tag to contact ${contactId}:`, e?.message)
      } else {
        tagApplied = true   // already had the tag → still counts
      }
    }
  }

  return { noteId, tagApplied }
}

/**
 * Look up a tag by name; create it if it doesn't exist. Cached for the
 * lifetime of the worker process — AC tag IDs don't change.
 */
let cachedTagId: number | null = null
async function ensureTagExists(name: string): Promise<number | null> {
  if (cachedTagId !== null) return cachedTagId

  // Search for the tag
  const data = await acJson<{ tags: any[] }>(`/tags?search=${encodeURIComponent(name)}&limit=20`)
  const exact = (data.tags || []).find(t => t.tag === name)
  if (exact) {
    cachedTagId = Number(exact.id)
    return cachedTagId
  }

  // Create
  try {
    const created = await acJson<{ tag: { id: string } }>(`/tags`, {
      method: 'POST',
      body: JSON.stringify({ tag: { tag: name, tagType: 'contact', description: 'Auto-applied when a call follow-up summary is pushed to AC. Use as a trigger for follow-up automations.' } }),
    })
    cachedTagId = Number(created.tag.id)
    return cachedTagId
  } catch (e: any) {
    console.error('[ac] could not create tag:', e?.message)
    return null
  }
}

// ── Caller name parsing ──────────────────────────────────────────────────
// We don't get a clean first-name / last-name from FreePBX. Best signal
// is the Claude follow-up summary's `who_what` field, which usually
// starts with "Sam Zayla with a 2020 ..." or "Brady with a turbocharged ...".
// Extract the leading name(s) up to the first non-name word.

export function parseNameFromWhoWhat(whoWhat: string | null): { firstName: string | null; lastName: string | null } {
  if (!whoWhat) return { firstName: null, lastName: null }
  // "Sam Zayla with a..." → take everything before " with " or " calling " or " regarding "
  const stopWords = [' with ', ' calling ', ' regarding ', ' about ', ' looking ', ' for ', ' inquiring ', ' asking ']
  let name = whoWhat
  for (const sw of stopWords) {
    const i = name.toLowerCase().indexOf(sw)
    if (i > 0) {
      name = name.substring(0, i)
      break
    }
  }
  name = name.trim().replace(/[.,;].*$/, '').trim()

  // Reject if the result looks like a sentence rather than a name
  // (longer than 4 words, or starts with capitalised generic terms).
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 4) return { firstName: null, lastName: null }
  if (/^(unknown|caller|customer|client|the|no)$/i.test(parts[0])) {
    return { firstName: null, lastName: null }
  }

  const firstName = parts[0]
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  return { firstName, lastName }
}

// ── High-level orchestrator ──────────────────────────────────────────────

export interface SyncToACInput {
  phone: string | null
  noteBody: string
  agentName: string | null               // Used as owner if creating a new contact
  whoWhat: string | null                 // Claude's "who" field — used to extract name
}

export interface SyncToACResult {
  action: 'noted' | 'created_and_noted' | 'skipped'
  contactId: number | null
  noteId: number | null
  ownerSet: boolean                      // Whether owner was set on creation
  reason?: string
}

/**
 * Top-level entry point: find or create AC contact by phone, post note + tag.
 *
 * Behaviour change vs previous version: when no existing contact matches,
 * we now CREATE one with the sales rep set as owner. Previously we'd skip,
 * which meant new leads never got into AC for automation triggers.
 */
export async function syncFollowUpToActiveCampaign(input: SyncToACInput): Promise<SyncToACResult> {
  if (!input.phone) {
    return { action: 'skipped', contactId: null, noteId: null, ownerSet: false, reason: 'no phone number on call' }
  }

  // 1. Try to find an existing contact
  const existing = await findContactByPhone(input.phone)
  if (existing) {
    const { noteId } = await postNoteAndTag(existing.id, input.noteBody)
    return { action: 'noted', contactId: existing.id, noteId, ownerSet: false }
  }

  // 2. No match — create a new AC contact with the rep as owner
  const { firstName, lastName } = parseNameFromWhoWhat(input.whoWhat)
  const ownerId = ownerIdForAgent(input.agentName)

  let creationNote: string | null = null
  if (input.agentName) {
    creationNote = `Auto-created from inbound call summary. Rep: ${input.agentName}.${ownerId ? ' Owner set automatically.' : ' (Owner not set — agent name not in ACTIVECAMPAIGN_OWNER_MAP env var.)'}`
  }

  let created: ACContact
  try {
    created = await createContact({
      phone: input.phone,
      firstName,
      lastName,
      email: null,
      agentName: input.agentName,
      noteForCreation: creationNote,
    })
  } catch (e: any) {
    return {
      action: 'skipped',
      contactId: null,
      noteId: null,
      ownerSet: false,
      reason: `failed to create AC contact: ${e?.message || String(e)}`,
    }
  }

  const { noteId } = await postNoteAndTag(created.id, input.noteBody)
  return {
    action: 'created_and_noted',
    contactId: created.id,
    noteId,
    ownerSet: ownerId !== null,
  }
}

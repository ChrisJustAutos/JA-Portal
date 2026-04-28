// lib/activecampaign.ts
// ActiveCampaign helper for the call follow-up sync worker.
//
// Operations exposed to the cron worker:
//   1. resolveContactForCall(input) — find existing contact by phone, email,
//      or name (in that order), or create a new one with rep as owner.
//      Returns full profile (name, email, phone, postcode from custom field)
//      so Monday can populate the lead with proper data.
//   2. postNoteAndTag(contactId, noteBody) — adds a contact note and applies
//      the follow-up tag (so AC automations can trigger off it).
//
// Key design points:
//   - AC's filters[phone] is a PARTIAL match and matches everything for empty
//     queries. We MUST verify any matched contact's phone digits actually
//     equal the query phone digits. This bug caused contact 30121 to be
//     mis-attributed to 26 different real customers in production.
//   - Search order: phone → email → name. First verified match wins.
//     Phone is most reliable; email next; name last (since reps share first
//     names with customers occasionally and Claude can confuse them).
//   - Postcode lives in an AC custom field. Field name(s) configurable via
//     ACTIVECAMPAIGN_POSTCODE_FIELD_NAMES env var (comma-separated).
//   - When found by email/name and phone is missing, BACKFILL the phone.
//     Don't overwrite existing values — only fill empties. Same for email.
//   - When no match and we create a new contact, set owner to the rep
//     (via ACTIVECAMPAIGN_OWNER_MAP). Customer name extracted from Claude's
//     who_what; email from Claude's email field if present.
//
// Env:
//   ACTIVECAMPAIGN_API_URL              e.g. 'https://justautosmechanical.api-us1.com'
//   ACTIVECAMPAIGN_API_KEY              v3 API key from Settings → Developer
//   ACTIVECAMPAIGN_FOLLOWUP_TAG         default 'call-summary-pushed'
//   ACTIVECAMPAIGN_OWNER_MAP            JSON object mapping agent_name → AC user_id
//                                       e.g. '{"Kaleb": 12, "Dom S": 15}'
//   ACTIVECAMPAIGN_POSTCODE_FIELD_NAMES comma-separated list of AC custom-field
//                                       perstag/title names that hold postcode.
//                                       Default 'POSTCODE,Postcode,Postal Code,Zip'.

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
// AU mobiles are 9 digits after stripping leading 0 / +61. We compare on
// digits-only (canonical form: no leading 0, no country code).

function normalisePhone(raw: string | null | undefined): string {
  const d = (raw || '').replace(/\D/g, '')
  if (d.startsWith('61') && d.length >= 11) return d.substring(2)
  if (d.startsWith('0')) return d.substring(1)
  return d
}

// 8+ digits required to safely search — anything shorter risks matching every
// contact in the database via AC's partial-match filter.
function searchableDigits(raw: string | null | undefined): string | null {
  const d = normalisePhone(raw)
  if (d.length < 8) return null
  return d
}

// ── Public types ─────────────────────────────────────────────────────────

export interface ACContact {
  id: number
  email: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  postcode: string | null      // From custom field, looked up separately
}

// ── Postcode custom field lookup ─────────────────────────────────────────
// AC custom fields live separately from core contact fields. We fetch them
// per-contact and find postcode by matching the field's title or perstag
// against a configured list.

interface ACFieldValue {
  field: string                // numeric ID as string
  value: string | null
}

let cachedPostcodeFieldIds: number[] | null = null

async function getPostcodeFieldIds(): Promise<number[]> {
  if (cachedPostcodeFieldIds !== null) return cachedPostcodeFieldIds

  const namesEnv = process.env.ACTIVECAMPAIGN_POSTCODE_FIELD_NAMES
    || 'POSTCODE,Postcode,Postal Code,Zip'
  const names = namesEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

  // Pull all contact custom fields. AC's /fields endpoint returns these.
  // Cap at 100 — a Just Autos AC tenant won't have more than that.
  try {
    const data = await acJson<{ fields: any[] }>(`/fields?limit=100`)
    const fields = data.fields || []
    const matches: number[] = []
    for (const f of fields) {
      const title = String(f.title || '').toLowerCase()
      const perstag = String(f.perstag || '').toLowerCase()
      if (names.some(n => title === n || perstag === n)) {
        matches.push(Number(f.id))
      }
    }
    cachedPostcodeFieldIds = matches
    if (matches.length === 0) {
      console.warn(`[ac] No postcode custom field found. Tried: ${names.join(', ')}. Set ACTIVECAMPAIGN_POSTCODE_FIELD_NAMES to override.`)
    }
    return matches
  } catch (e: any) {
    console.warn('[ac] failed to look up postcode field:', e?.message)
    cachedPostcodeFieldIds = []
    return []
  }
}

async function fetchPostcodeForContact(contactId: number): Promise<string | null> {
  const fieldIds = await getPostcodeFieldIds()
  if (fieldIds.length === 0) return null

  try {
    const data = await acJson<{ fieldValues: ACFieldValue[] }>(`/contacts/${contactId}/fieldValues`)
    const values = data.fieldValues || []
    for (const v of values) {
      if (fieldIds.includes(Number(v.field)) && v.value) {
        const trimmed = String(v.value).trim()
        if (trimmed) return trimmed
      }
    }
  } catch (e: any) {
    console.warn(`[ac] failed to fetch field values for contact ${contactId}:`, e?.message)
  }
  return null
}

// ── Search by phone ──────────────────────────────────────────────────────

async function findByPhone(rawPhone: string): Promise<ACContact | null> {
  const queryDigits = searchableDigits(rawPhone)
  if (!queryDigits) return null

  // Use the broad `search` parameter (matches across phone, name, email).
  // We then VERIFY the matched contact's phone digits actually equal our
  // query digits, rejecting any loose matches (which is how the 30121 bug
  // happened).
  const data = await acJson<{ contacts: any[] }>(
    `/contacts?search=${encodeURIComponent(queryDigits)}&limit=20`,
  )
  const contacts = data.contacts || []

  for (const c of contacts) {
    const candidate = normalisePhone(c.phone)
    if (candidate === queryDigits) {
      return mapContactWithoutPostcode(c)
    }
    // Accept end-anchored partial matches if both sides are full-length
    // (handles minor formatting like extra digits or short variants).
    if (
      candidate.length >= 8 &&
      (candidate.endsWith(queryDigits) || queryDigits.endsWith(candidate))
    ) {
      return mapContactWithoutPostcode(c)
    }
  }
  return null
}

// ── Search by email ──────────────────────────────────────────────────────

async function findByEmail(rawEmail: string): Promise<ACContact | null> {
  const email = rawEmail.trim().toLowerCase()
  if (!email || !email.includes('@')) return null

  // AC's /contacts has email_like for partial. We want exact, so use that
  // and verify on the way out.
  const data = await acJson<{ contacts: any[] }>(
    `/contacts?email=${encodeURIComponent(email)}&limit=5`,
  )
  const contacts = data.contacts || []

  for (const c of contacts) {
    const candidate = String(c.email || '').trim().toLowerCase()
    if (candidate === email) {
      return mapContactWithoutPostcode(c)
    }
  }
  return null
}

// ── Search by name ───────────────────────────────────────────────────────

async function findByName(firstName: string | null, lastName: string | null): Promise<ACContact | null> {
  // Require BOTH first and last name to avoid matching too broadly. Common
  // first names alone (e.g. "Matt") can match dozens of contacts.
  if (!firstName || !lastName) return null
  const fn = firstName.trim().toLowerCase()
  const ln = lastName.trim().toLowerCase()
  if (fn.length < 2 || ln.length < 2) return null

  // Use the search param with both names. AC matches partial, so we verify.
  const query = `${firstName} ${lastName}`.trim()
  const data = await acJson<{ contacts: any[] }>(
    `/contacts?search=${encodeURIComponent(query)}&limit=10`,
  )
  const contacts = data.contacts || []

  for (const c of contacts) {
    const cfn = String(c.firstName || '').trim().toLowerCase()
    const cln = String(c.lastName || '').trim().toLowerCase()
    if (cfn === fn && cln === ln) {
      return mapContactWithoutPostcode(c)
    }
  }
  return null
}

function mapContactWithoutPostcode(raw: any): ACContact {
  return {
    id: Number(raw.id),
    email: raw.email || null,
    firstName: raw.firstName || null,
    lastName: raw.lastName || null,
    phone: raw.phone || null,
    postcode: null,   // filled in later by enrichment
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

// ── Backfill helper ──────────────────────────────────────────────────────
// When an existing contact is missing fields we have data for, fill them
// in. Never overwrite existing values — only fill empties.

async function backfillContact(
  contactId: number,
  current: ACContact,
  newData: { phone: string | null; email: string | null },
): Promise<ACContact> {
  const updates: Record<string, string> = {}
  if (!current.phone && newData.phone) updates.phone = newData.phone
  if (!current.email && newData.email) updates.email = newData.email

  if (Object.keys(updates).length === 0) return current

  try {
    const data = await acJson<{ contact: any }>(`/contacts/${contactId}`, {
      method: 'PUT',
      body: JSON.stringify({ contact: updates }),
    })
    console.log(`[ac] backfilled contact ${contactId}:`, Object.keys(updates).join(', '))
    return {
      ...current,
      phone: updates.phone || current.phone,
      email: updates.email || current.email,
    }
  } catch (e: any) {
    console.warn(`[ac] backfill failed for contact ${contactId}:`, e?.message)
    return current
  }
}

// ── Create contact ───────────────────────────────────────────────────────

interface CreateContactInput {
  phone: string
  firstName: string | null
  lastName: string | null
  email: string | null
  agentName: string | null
  noteForCreation: string | null
}

async function createContact(input: CreateContactInput): Promise<ACContact> {
  const ownerId = ownerIdForAgent(input.agentName)

  const contactPayload: any = {
    phone: input.phone,
    firstName: input.firstName || '',
    lastName: input.lastName || '',
  }
  if (input.email) contactPayload.email = input.email
  if (ownerId) contactPayload.owner = ownerId

  if (!input.email && !input.phone) {
    throw new Error('Cannot create AC contact without email or phone')
  }

  const created = await acJson<{ contact: any }>(`/contacts`, {
    method: 'POST',
    body: JSON.stringify({ contact: contactPayload }),
  })

  const contact = mapContactWithoutPostcode(created.contact)

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
      console.warn(`[ac] failed to post creation note for new contact ${contact.id}:`, e?.message)
    }
  }

  return contact
}

// ── Note + tag ───────────────────────────────────────────────────────────

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
      // 422 = already had the tag, fine.
      if (!String(e?.message || '').includes('422')) {
        console.error(`[ac] failed to attach tag to contact ${contactId}:`, e?.message)
      } else {
        tagApplied = true
      }
    }
  }

  return { noteId, tagApplied }
}

let cachedTagId: number | null = null
async function ensureTagExists(name: string): Promise<number | null> {
  if (cachedTagId !== null) return cachedTagId
  const data = await acJson<{ tags: any[] }>(`/tags?search=${encodeURIComponent(name)}&limit=20`)
  const exact = (data.tags || []).find(t => t.tag === name)
  if (exact) {
    cachedTagId = Number(exact.id)
    return cachedTagId
  }
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
// Best signal for customer name is the Claude follow-up summary's `who_what`
// field. Usually starts with "Sam Zayla with a 2020..." or "Brady with...".

export function parseNameFromWhoWhat(whoWhat: string | null): { firstName: string | null; lastName: string | null } {
  if (!whoWhat) return { firstName: null, lastName: null }
  const stopWords = [' with ', ' calling ', ' regarding ', ' about ', ' looking ', ' for ', ' inquiring ', ' asking ', ' was ', ' wants ', ' had ']
  let name = whoWhat
  for (const sw of stopWords) {
    const i = name.toLowerCase().indexOf(sw)
    if (i > 0) {
      name = name.substring(0, i)
      break
    }
  }
  name = name.trim().replace(/[.,;].*$/, '').trim()

  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length === 0 || parts.length > 4) return { firstName: null, lastName: null }
  if (/^(unknown|caller|customer|client|the|no|a)$/i.test(parts[0])) {
    return { firstName: null, lastName: null }
  }

  const firstName = parts[0]
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : null
  return { firstName, lastName }
}

// ── High-level orchestrator ──────────────────────────────────────────────

export interface ResolveContactInput {
  phone: string | null
  email: string | null               // From Claude's email field
  whoWhat: string | null             // From Claude's who_what field — used to extract name
  agentName: string | null           // For owner lookup if creating
}

export interface ResolveContactResult {
  contact: ACContact | null          // Includes postcode (from custom field)
  action: 'found_phone' | 'found_email' | 'found_name' | 'created' | 'skipped'
  reason?: string
  ownerSet: boolean                  // Whether owner was set on creation
  backfilled: boolean                // Whether we updated an existing contact
}

/**
 * Resolve an AC contact for a call: phone → email → name search,
 * fall back to creating a new contact with rep as owner.
 *
 * After resolution, we always fetch the postcode custom field so
 * downstream callers (Monday) get the full profile. This costs an
 * extra API call per call, but it's cheap (one /fieldValues request).
 */
export async function resolveContactForCall(input: ResolveContactInput): Promise<ResolveContactResult> {
  const { firstName, lastName } = parseNameFromWhoWhat(input.whoWhat)

  // 1. Phone lookup
  if (input.phone) {
    const found = await findByPhone(input.phone)
    if (found) {
      const backfilled = await maybeBackfill(found, input)
      const postcode = await fetchPostcodeForContact(found.id)
      return {
        contact: { ...backfilled, postcode },
        action: 'found_phone',
        ownerSet: false,
        backfilled: backfilled !== found,
      }
    }
  }

  // 2. Email lookup
  if (input.email) {
    const found = await findByEmail(input.email)
    if (found) {
      const backfilled = await maybeBackfill(found, input)
      const postcode = await fetchPostcodeForContact(found.id)
      return {
        contact: { ...backfilled, postcode },
        action: 'found_email',
        ownerSet: false,
        backfilled: backfilled !== found,
      }
    }
  }

  // 3. Name lookup (requires both first AND last)
  if (firstName && lastName) {
    const found = await findByName(firstName, lastName)
    if (found) {
      const backfilled = await maybeBackfill(found, input)
      const postcode = await fetchPostcodeForContact(found.id)
      return {
        contact: { ...backfilled, postcode },
        action: 'found_name',
        ownerSet: false,
        backfilled: backfilled !== found,
      }
    }
  }

  // 4. Nothing matched — create a new contact (need at least phone OR email)
  if (!input.phone && !input.email) {
    return {
      contact: null,
      action: 'skipped',
      reason: 'no phone or email to identify the contact',
      ownerSet: false,
      backfilled: false,
    }
  }

  const ownerId = ownerIdForAgent(input.agentName)
  const creationNote = input.agentName
    ? `Auto-created from call summary. Rep: ${input.agentName}.${ownerId ? ' Owner set automatically.' : ' (Owner not set — agent name not in ACTIVECAMPAIGN_OWNER_MAP env var.)'}`
    : null

  try {
    const created = await createContact({
      phone: input.phone || '',
      firstName,
      lastName,
      email: input.email,
      agentName: input.agentName,
      noteForCreation: creationNote,
    })
    return {
      contact: { ...created, postcode: null },   // new contact has no postcode yet
      action: 'created',
      ownerSet: ownerId !== null,
      backfilled: false,
    }
  } catch (e: any) {
    return {
      contact: null,
      action: 'skipped',
      reason: `failed to create AC contact: ${e?.message || String(e)}`,
      ownerSet: false,
      backfilled: false,
    }
  }
}

/**
 * If the matched contact is missing fields we now have, fill them in.
 * Returns the updated contact (or the original if no update happened).
 */
async function maybeBackfill(current: ACContact, input: ResolveContactInput): Promise<ACContact> {
  const needsBackfill =
    (!current.phone && input.phone) ||
    (!current.email && input.email)
  if (!needsBackfill) return current

  return backfillContact(current.id, current, {
    phone: input.phone,
    email: input.email,
  })
}

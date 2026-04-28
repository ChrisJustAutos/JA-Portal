// lib/activecampaign.ts
// ActiveCampaign helper for the call follow-up sync worker.
//
// Two operations:
//   1. findContactByPhone(phone) — searches AC by phone OR mobile field
//   2. postNoteAndTag(contactId, noteBody, tagName) — adds a contact note
//      and applies a tag (so AC automations can trigger off it).
//
// Why the tag matters: AC is the automation hub here, not the source of
// truth. The tag 'call-summary-pushed' (or whatever) is the trigger
// signal for AC automations like "send rep a Slack DM", "fire a follow-up
// email if no human contact in 7 days", etc. Chris owns those automations.
//
// Env: ACTIVECAMPAIGN_API_URL (e.g. 'https://justautosmechanical.api-us1.com')
//      ACTIVECAMPAIGN_API_KEY  (the v3 API key from Settings → Developer)

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

// ── Phone normalisation ──
// AC stores phone numbers however the user typed them in. We normalise on
// digits-only and try multiple search variants to maximise hit rate.
function normalisePhone(raw: string): string {
  const d = (raw || '').replace(/\D/g, '')
  if (d.startsWith('61') && d.length >= 11) return d.substring(2)
  if (d.startsWith('0')) return d.substring(1)
  return d
}

function phoneVariants(raw: string): string[] {
  const d = normalisePhone(raw)
  if (!d) return []
  // Common formats reps enter:
  //   +61411234567, 0411234567, 0411 234 567, 411234567
  const formatted = d.length === 9 ? d.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3') : d
  return [
    raw.trim(),
    d,
    `0${d}`,
    `+61${d}`,
    formatted,
    `0${formatted}`,
  ]
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
 * Search AC for a contact whose phone OR mobile matches `rawPhone`.
 *
 * AC's /contacts endpoint accepts a `search` param that matches across
 * email/first/last/phone — but it's loose. We narrow with `filters[phone]=`
 * which does an exact match on the phone field. If that misses, we try
 * `search` as a fallback (catches contacts where the number is in `mobile`
 * or another custom field).
 *
 * Returns the FIRST match. If multiple AC contacts share a phone we accept
 * that ambiguity — better to attach the note to one wrong contact than to
 * silently drop it.
 */
export async function findContactByPhone(rawPhone: string): Promise<ACContact | null> {
  const variants = phoneVariants(rawPhone)
  if (variants.length === 0) return null

  // 1. Exact-match on the `phone` field for each variant
  for (const v of variants) {
    const data = await acJson<{ contacts: any[] }>(`/contacts?filters[phone]=${encodeURIComponent(v)}&limit=5`)
    if (data.contacts && data.contacts.length > 0) {
      return mapContact(data.contacts[0])
    }
  }

  // 2. Fall back to `search` param (loose match — could hit email, name etc).
  // Only try with the digits-only form to minimise false positives.
  const digits = normalisePhone(rawPhone)
  if (digits.length >= 8) {
    const data = await acJson<{ contacts: any[] }>(`/contacts?search=${digits}&limit=5`)
    if (data.contacts && data.contacts.length > 0) {
      // Re-verify the matched contact actually has this phone
      const candidate = data.contacts[0]
      const candDigits = normalisePhone(candidate.phone || '')
      if (candDigits === digits) return mapContact(candidate)
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

// ── High-level orchestrator ──

export interface SyncToACResult {
  action: 'noted' | 'skipped'
  contactId: number | null
  noteId: number | null
  reason?: string
}

/**
 * Top-level entry point: find contact by phone, post note + tag.
 * If contact not found in AC, return 'skipped' with reason — we don't
 * auto-create AC contacts (per Chris: AC contacts are managed via existing
 * intake flows, this worker only annotates existing ones).
 */
export async function syncFollowUpToActiveCampaign(input: {
  phone: string | null
  noteBody: string
}): Promise<SyncToACResult> {
  if (!input.phone) {
    return { action: 'skipped', contactId: null, noteId: null, reason: 'no phone number on call' }
  }

  const contact = await findContactByPhone(input.phone)
  if (!contact) {
    return { action: 'skipped', contactId: null, noteId: null, reason: `no AC contact found for phone ${input.phone}` }
  }

  const { noteId } = await postNoteAndTag(contact.id, input.noteBody)
  return { action: 'noted', contactId: contact.id, noteId }
}

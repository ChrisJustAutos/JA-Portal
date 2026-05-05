// lib/monday-followup.ts
// Find-or-create logic for posting follow-up notes to Monday Quote Channel boards.
//
// The lead-flow lives in 5 per-rep boards (Graham/Kaleb/Dom/James/Tyronne).
// Strategy:
//   1. Search ALL 5 boards by phone number → if found, update that item
//      regardless of which rep's board it's on (per Chris's call: "leave it
//      where it is, append the note").
//   2. If no phone match, fall back to caller_name fuzzy match across all boards.
//   3. If still no match, CREATE a new item on the rep-of-the-call's board,
//      in the "Quote - Lead" group, with sentiment-driven status.
//
// New in this version: when creating a new Monday item, we accept a
// pre-resolved AC contact profile (name, email, phone, postcode) and use
// THAT data to populate the lead. Falls back to call-supplied data if
// AC didn't have a profile. AC is the source of truth for contact details;
// Monday is the lead-pipeline view.
//
// Contact-attempts counter (5 May 2026): the counter column ID is no
// longer hardcoded — we resolve it per-board at runtime by querying the
// board's columns and matching on title. James and Tyronne had different
// IDs to the original 3 boards, which caused 'invalid column id' errors
// on every update. Now self-heals; the bump is best-effort and never
// fails the note posting.
//
// All Monday API calls go through a single fetch helper that uses the
// MONDAY_API_TOKEN env var. Don't import this from a request-scoped handler
// without setting MONDAY_API_TOKEN — it'll throw on first call.
//
// EXPORTS for reuse: mondayQuery, escGqlString, and searchBoardByPhone are
// exported so lib/monday-update.ts (quote-pipeline) can reuse the GraphQL
// machinery without duplication. Promoted 2026-04-29 — no behaviour change.

const MONDAY_API_URL = 'https://api.monday.com/v2'

// Hard-coded board IDs for the 5 active rep boards.
// Source: monday.com listing on 28 Apr 2026. If a new rep joins or boards
// are renamed, update here. Old Dom Quote Channel (2025362007) is
// intentionally excluded — it's archived.
//
// Each agent_name → board_id mapping. Lower-cased keys for tolerant lookup.
// First-name match against `calls.agent_name` or `calls.effective_advisor_name`.
export const REP_BOARDS: Record<string, { boardId: string; repName: string }> = {
  graham:   { boardId: '5026840169', repName: 'Graham' },
  kaleb:    { boardId: '5025942316', repName: 'Kaleb' },
  dom:      { boardId: '5025942308', repName: 'Dom' },
  james:    { boardId: '5025942292', repName: 'James' },
  tyronne:  { boardId: '5025942288', repName: 'Tyronne' },
}

// All board IDs we'll search when finding existing items, regardless of rep.
export const ALL_QUOTE_BOARD_IDS = Object.values(REP_BOARDS).map(b => b.boardId)

// Column IDs on the Quote Channel boards.
// Most are consistent across all 5 boards (forked from the same template).
// EXCEPTION: CONTACT_ATTEMPTS — James and Tyronne have different IDs, so we
// resolve per-board at runtime via getContactAttemptsColumnId() instead of
// using a hardcoded value here.
export const COLUMNS = {
  PHONE:           'text_mkzbenay',
  EMAIL:           'text_mkzbpqje',
  POSTCODE:        'text_mkzc86wk',
  DISTRIBUTOR:     'text_mkzefrrm',
  QUOTE_VALUE:     'numeric_mkzcbhz2',
  DATE:            'date4',
  STATUS:          'status',
  QUALIFYING_STAGE:'text_mm1jn5v0',
  OWNER:           'person',
}

// Status label index (from board settings_str → labels). Mapping used for new-item creation.
// Indices come straight from the Status column settings.
export const STATUS_INDICES = {
  FOLLOW_UP_DONE: 0,
  QUOTE_WON: 1,
  QUOTE_LOST: 2,
  RLMNA: 3,
  QUOTE_NOT_ISSUED: 4,
  NOT_DONE: 5,
  QUOTE_SENT: 6,
  THREE_DAYS: 7,
  FOURTEEN_DAYS: 8,
  QUOTE_ON_HOLD: 9,
}

// Group IDs (consistent across rep boards). Where new items land.
export const GROUPS = {
  QUOTE_LEAD: 'topics',         // "Quote - Lead"
  FOLLOW_UP: 'group_title',     // "Quote - Follow Up"
  PENDING: 'new_group__1',      // "Quote - Pending"
  WON: 'new_group',
  LOST: 'new_group860',
  ON_HOLD: 'group_mm12crrx',
}

// ── Phone normalisation ──────────────────────────────────────────────────
// Compares only the digits — handles +61, 0411, formatted numbers, etc.

export function normalisePhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('61') && digits.length >= 11) return digits.substring(2)
  if (digits.startsWith('0')) return digits.substring(1)
  return digits
}

function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalisePhone(a)
  const nb = normalisePhone(b)
  if (!na || !nb) return false
  return na === nb
}

// ── Monday API helper ────────────────────────────────────────────────────
//
// Exported for reuse by lib/monday-update.ts. All Monday GraphQL calls in
// this codebase should go through this function — it handles auth, error
// shape, and response unwrapping in one place.

export async function mondayQuery<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not configured')

  const r = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Monday API ${r.status}: ${errText.substring(0, 500)}`)
  }
  const data = await r.json()
  if (data.errors) {
    throw new Error(`Monday GraphQL: ${JSON.stringify(data.errors).substring(0, 500)}`)
  }
  return data.data as T
}

// Escape a value for safe inline use inside a GraphQL query string.
// Used because Monday's `compare_value` is a CompareValue scalar and
// passing it as a typed variable (e.g. [String]!) results in:
// "Variable $vals of type [String]! used in position expecting type CompareValue!"
// Inlining as a JSON literal sidesteps that entirely.
//
// Exported for reuse by lib/monday-update.ts (quote-pipeline phone search).
export function escGqlString(s: string): string {
  return JSON.stringify(s)
}

// ── Per-board column ID resolution ───────────────────────────────────────
//
// The "Contact Attempts" counter column has different IDs on different
// boards (James and Tyronne were diverged at creation time and never
// reconciled). Rather than hardcoding, we look up the ID per board at
// runtime via the board's column metadata.
//
// Cache scope: module-level. Persists across warm Vercel function
// invocations; resets on cold start. Worst case = 5 column-list queries
// per cold start. Cache stores `null` for boards where the column doesn't
// exist so we don't repeatedly probe.

const contactAttemptsColIdCache = new Map<string, string | null>()

/**
 * Find the contact-attempts counter column ID on the given board.
 * Matches any numeric column whose title contains "attempt" (case-insensitive).
 * Returns null if no such column exists OR the lookup itself fails — the
 * caller should treat null as "skip the bump", not as an error.
 */
async function getContactAttemptsColumnId(boardId: string): Promise<string | null> {
  if (contactAttemptsColIdCache.has(boardId)) {
    return contactAttemptsColIdCache.get(boardId) ?? null
  }
  try {
    const data = await mondayQuery<{ boards: Array<{ columns: Array<{ id: string; title: string; type: string }> }> }>(
      `query GetCols($boardId: [ID!]) {
        boards(ids: $boardId) {
          columns { id title type }
        }
      }`,
      { boardId: [boardId] },
    )
    const cols = data.boards?.[0]?.columns || []
    const match = cols.find(c =>
      c.type === 'numbers' && /attempt/i.test(c.title || '')
    )
    const resolved = match?.id || null
    contactAttemptsColIdCache.set(boardId, resolved)
    return resolved
  } catch (e: any) {
    // Cache the miss so we don't retry per-job. Will recover next cold start.
    console.warn(`getContactAttemptsColumnId(${boardId}) failed: ${e?.message || e}`)
    contactAttemptsColIdCache.set(boardId, null)
    return null
  }
}

// ── Lookup: find an existing item across all 5 boards ────────────────────

export interface FoundItem {
  itemId: string
  itemName: string
  boardId: string
  boardName: string
  phone: string | null
  email: string | null
}

export async function findExistingItem(
  phone: string | null,
  callerName: string | null,
): Promise<FoundItem | null> {
  // ── Phase 1: phone lookup ──
  if (phone) {
    const np = normalisePhone(phone)
    if (np) {
      const variants = Array.from(new Set([
        phone,
        np,
        `0${np}`,
        `+61${np}`,
        np.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3'),
      ]))

      for (const boardId of ALL_QUOTE_BOARD_IDS) {
        const found = await searchBoardByPhone(boardId, variants)
        if (found) return found
      }
    }
  }

  // ── Phase 2: name fallback ──
  if (callerName && callerName.trim().length >= 3) {
    const norm = callerName.trim().toLowerCase()
    for (const boardId of ALL_QUOTE_BOARD_IDS) {
      const found = await searchBoardByNameFuzzy(boardId, norm)
      if (found) return found
    }
  }

  return null
}

// Exported for reuse by lib/monday-update.ts (Pipeline A phone-match flow).
// Returns the first item on `boardId` whose PHONE column matches any of
// `phoneVariants` (server-side filter), with client-side digit verification.
export async function searchBoardByPhone(boardId: string, phoneVariants: string[]): Promise<FoundItem | null> {
  const inlinedVals = `[${phoneVariants.map(escGqlString).join(', ')}]`

  const data = await mondayQuery<{ boards: Array<{ name: string; items_page: { items: any[] } }> }>(
    `query SearchPhone($boardId: [ID!]) {
      boards(ids: $boardId) {
        name
        items_page(
          limit: 50
          query_params: {
            rules: [{ column_id: "${COLUMNS.PHONE}", compare_value: ${inlinedVals}, operator: any_of }]
          }
        ) {
          items {
            id
            name
            column_values(ids: ["${COLUMNS.PHONE}", "${COLUMNS.EMAIL}"]) { id text }
          }
        }
      }
    }`,
    { boardId: [boardId] },
  )

  const board = data.boards?.[0]
  if (!board) return null
  const items = board.items_page?.items || []

  for (const item of items) {
    const phoneCol = item.column_values?.find((cv: any) => cv.id === COLUMNS.PHONE)
    const emailCol = item.column_values?.find((cv: any) => cv.id === COLUMNS.EMAIL)
    if (phonesMatch(phoneCol?.text, phoneVariants[0])) {
      return {
        itemId: item.id,
        itemName: item.name,
        boardId,
        boardName: board.name,
        phone: phoneCol?.text || null,
        email: emailCol?.text || null,
      }
    }
  }
  return null
}

async function searchBoardByNameFuzzy(boardId: string, normalisedName: string): Promise<FoundItem | null> {
  const data = await mondayQuery<{ boards: Array<{ name: string; items_page: { items: any[] } }> }>(
    `query SearchName($boardId: [ID!]) {
      boards(ids: $boardId) {
        name
        items_page(limit: 200) {
          items {
            id name
            column_values(ids: ["${COLUMNS.PHONE}", "${COLUMNS.EMAIL}"]) { id text }
          }
        }
      }
    }`,
    { boardId: [boardId] },
  )

  const board = data.boards?.[0]
  if (!board) return null
  const items = board.items_page?.items || []
  const words = normalisedName.split(/\s+/).filter(w => w.length >= 2)
  if (words.length === 0) return null

  for (const item of items) {
    const itemLower = (item.name || '').toLowerCase()
    if (words.every(w => itemLower.includes(w))) {
      const phoneCol = item.column_values?.find((cv: any) => cv.id === COLUMNS.PHONE)
      const emailCol = item.column_values?.find((cv: any) => cv.id === COLUMNS.EMAIL)
      return {
        itemId: item.id,
        itemName: item.name,
        boardId,
        boardName: board.name,
        phone: phoneCol?.text || null,
        email: emailCol?.text || null,
      }
    }
  }
  return null
}

// ── Update existing item ─────────────────────────────────────────────────
//
// Two-step:
//   1. Post the follow-up note as an Update on the item (always works —
//      column-agnostic mutation).
//   2. Bump the contact-attempts counter (best-effort — wrapped in
//      try/catch and tolerant of missing/different column IDs per board).
//
// If step 2 fails for any reason — column doesn't exist on this board,
// network blip, anything — we log a warning and return successfully. The
// note (the actual deliverable) has already been posted. We do not throw
// on counter failures because they used to take down the whole follow-up
// job and create false-positive Monday errors in the job log.

export async function updateExistingItem(
  itemId: string,
  boardId: string,
  noteBody: string,
): Promise<void> {
  // Step 1: Post the note. THIS is the primary deliverable.
  await mondayQuery(
    `mutation PostUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body: noteBody },
  )

  // Step 2: Best-effort counter bump.
  try {
    const colId = await getContactAttemptsColumnId(boardId)
    if (!colId) {
      // Column doesn't exist on this board — skip silently. Not an error.
      return
    }

    const cur = await mondayQuery<{ items: any[] }>(
      `query GetAttempts($itemId: [ID!]) {
        items(ids: $itemId) {
          column_values(ids: ["${colId}"]) { text }
        }
      }`,
      { itemId: [itemId] },
    )
    const curText = cur.items?.[0]?.column_values?.[0]?.text || ''
    const curNum = parseInt(curText, 10) || 0
    const next = curNum + 1

    await mondayQuery(
      `mutation BumpAttempts($itemId: ID!, $boardId: ID!, $value: String!) {
        change_simple_column_value(
          item_id: $itemId
          board_id: $boardId
          column_id: "${colId}"
          value: $value
        ) { id }
      }`,
      { itemId, boardId, value: String(next) },
    )
  } catch (e: any) {
    // Don't fail the whole call — note was already posted in Step 1.
    console.warn(`Contact attempts bump failed on board ${boardId}, item ${itemId}: ${e?.message || e}`)
  }
}

// ── Create new item ──────────────────────────────────────────────────────

interface NewItemInput {
  agentName: string
  // Profile data — prefer AC profile values, fall back to call data
  customerFirstName: string | null
  customerLastName: string | null
  phone: string | null
  email: string | null
  postcode: string | null
  // Behaviour
  sentiment: 'hot' | 'warm' | 'cold'
  noteBody: string
  callDate: string
}

interface NewItemResult {
  itemId: string
  boardId: string
  boardName: string
}

/**
 * Create a new lead item on the rep's board, in the "Quote - Lead" group,
 * pre-populated with the customer's contact details. Then post the note
 * as the first update on the item.
 *
 * Sentiment maps to status:
 *   - hot/warm  → "Quote - Lead" group, no specific status (rep handles)
 *   - cold      → "Quote - Lost" status applied immediately so it doesn't
 *                 clutter the active follow-up queue
 */
export async function createNewItem(input: NewItemInput): Promise<NewItemResult> {
  const repKey = input.agentName.trim().split(/\s+/)[0].toLowerCase()
  const board = REP_BOARDS[repKey]
  if (!board) {
    throw new Error(`No Quote Channel board for rep '${input.agentName}'. Known reps: ${Object.values(REP_BOARDS).map(b => b.repName).join(', ')}`)
  }

  // Item name format: "First Last" matches existing convention.
  // If we don't have a name, fall back to phone-based label.
  const fullName = [input.customerFirstName, input.customerLastName]
    .filter(Boolean)
    .join(' ')
    .trim()
  const itemName = fullName
    || (input.phone ? `Call from ${input.phone}` : 'Unknown caller')

  // Build column_values map. Monday wants this as a JSON-encoded string.
  const columnValues: Record<string, any> = {}
  if (input.phone) columnValues[COLUMNS.PHONE] = input.phone
  if (input.email) columnValues[COLUMNS.EMAIL] = input.email
  if (input.postcode) columnValues[COLUMNS.POSTCODE] = input.postcode
  columnValues[COLUMNS.DATE] = { date: new Date(input.callDate).toISOString().substring(0, 10) }

  // Sentiment → status column
  if (input.sentiment === 'cold') {
    columnValues[COLUMNS.STATUS] = { index: STATUS_INDICES.QUOTE_LOST }
  }
  // hot/warm → leave status null, lands in default state for the group

  // Choose group — cold goes straight to "Lost", others go to "Lead"
  const groupId = input.sentiment === 'cold' ? GROUPS.LOST : GROUPS.QUOTE_LEAD

  const created = await mondayQuery<{ create_item: { id: string } }>(
    `mutation CreateLead($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        group_id: $groupId
        item_name: $itemName
        column_values: $columnValues
        create_labels_if_missing: false
      ) { id }
    }`,
    {
      boardId: board.boardId,
      groupId,
      itemName,
      columnValues: JSON.stringify(columnValues),
    },
  )

  const itemId = created.create_item.id

  await mondayQuery(
    `mutation PostFirstUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body: input.noteBody },
  )

  return { itemId, boardId: board.boardId, boardName: `${board.repName} Quote Channel` }
}

// ── High-level orchestrator ──────────────────────────────────────────────

export interface SyncToMondayInput {
  agentName: string | null
  callerName: string | null              // From CDR — used for fallback name search
  phone: string | null
  // Profile (preferred from AC if resolved)
  customerFirstName: string | null
  customerLastName: string | null
  email: string | null
  postcode: string | null
  // Behaviour
  sentiment: 'hot' | 'warm' | 'cold'
  noteBody: string
  callDate: string
}

export interface SyncToMondayResult {
  action: 'created' | 'updated' | 'skipped'
  itemId: string | null
  boardId: string | null
  boardName: string | null
  reason?: string
}

export async function syncFollowUpToMonday(input: SyncToMondayInput): Promise<SyncToMondayResult> {
  if (!input.agentName) {
    return { action: 'skipped', itemId: null, boardId: null, boardName: null, reason: 'no agent_name on call' }
  }

  // Build the search-name from AC profile if we have it, else from CDR callerName
  const searchName = [input.customerFirstName, input.customerLastName]
    .filter(Boolean)
    .join(' ')
    .trim()
    || input.callerName
    || null

  if (!input.phone && !searchName) {
    return { action: 'skipped', itemId: null, boardId: null, boardName: null, reason: 'no phone or name to match against' }
  }

  // 1. Try to find existing item across all 5 boards
  const found = await findExistingItem(input.phone, searchName)
  if (found) {
    await updateExistingItem(found.itemId, found.boardId, input.noteBody)
    return {
      action: 'updated',
      itemId: found.itemId,
      boardId: found.boardId,
      boardName: found.boardName,
    }
  }

  // 2. No match — create new on rep's board
  const repKey = input.agentName.trim().split(/\s+/)[0].toLowerCase()
  if (!REP_BOARDS[repKey]) {
    return { action: 'skipped', itemId: null, boardId: null, boardName: null, reason: `unknown rep '${input.agentName}' — no board configured` }
  }

  const created = await createNewItem({
    agentName: input.agentName,
    customerFirstName: input.customerFirstName,
    customerLastName: input.customerLastName,
    phone: input.phone,
    email: input.email,
    postcode: input.postcode,
    sentiment: input.sentiment,
    noteBody: input.noteBody,
    callDate: input.callDate,
  })

  return {
    action: 'created',
    itemId: created.itemId,
    boardId: created.boardId,
    boardName: created.boardName,
  }
}

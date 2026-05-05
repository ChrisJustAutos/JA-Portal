// lib/monday-update.ts
// Monday GraphQL operations specific to the quote pipeline.
// Reuses mondayQuery / escGqlString / searchBoardByPhone from monday-followup.ts
// so we have ONE GraphQL client and ONE phone-search implementation across
// the codebase.
//
// Used by:
//   - Pipeline B (Monday "Fetch Call Notes" button): createUpdate only.
//   - Pipeline A (quote ingestion):
//       findItemByPhone        — lookup across 5 rep boards
//       updateItemColumns      — set quote value, quote number, last quote date
//       addFileToColumn        — upload latest quote PDF
//       createUpdate           — append "Quote {n} sent ${total}..." note
//
// What this file does NOT do:
//   - Match-or-create. Pipeline A's design is match-only; if no match,
//     skip Monday entirely (Make handles new lead creation via AC). So
//     we never create new items from this file. Pipeline B already has
//     an item ID from Monday's integration recipe.
//   - Bump Contact Attempts unconditionally. The design says "bump if
//     column exists" — handled by bumpContactAttempts below using the
//     per-board column resolver from monday-followup.

import {
  mondayQuery,
  searchBoardByPhone,
  getContactAttemptsColumnId,
  COLUMNS,
  ALL_QUOTE_BOARD_IDS,
  type FoundItem,
} from './monday-followup'

// ── Pipeline B: post a text update on an item ───────────────────────────

/**
 * Post a text update (the "log a note" feature) on a Monday item.
 * Used by Pipeline B's button-fetch endpoint and Pipeline A's matched-item
 * note. Idempotency is the caller's problem — Monday allows duplicate
 * updates; we don't try to deduplicate.
 */
export async function createUpdate(itemId: string, body: string): Promise<{ updateId: string }> {
  const data = await mondayQuery<{ create_update: { id: string } }>(
    `mutation PostUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body },
  )
  return { updateId: data.create_update.id }
}


// ── Pipeline A: phone-match across all rep boards ───────────────────────

/**
 * Find the FIRST Monday item across ALL 5 Quote Channel boards whose
 * phone column matches any of the provided variants. Returns null if
 * no match is found — Pipeline A's design is to skip Monday in that case
 * and let Make create the lead via AC's deal-creation webhook.
 *
 * Variants should include: raw input, +61... form, 0... form, and the
 * digits-only form. The caller (Pipeline A) generates these from the
 * parsed PDF phone the same way buildPhoneVariants does in
 * lib/quote-call-context.ts.
 *
 * Iterates boards sequentially (not parallel) for two reasons:
 *   1. First-match-wins semantics — once we find the customer, we don't
 *      care if another rep also has a record for them.
 *   2. Monday API rate limits — sequential calls under the 60-req/sec
 *      account cap with margin.
 */
export async function findItemByPhone(phoneVariants: string[]): Promise<FoundItem | null> {
  if (phoneVariants.length === 0) return null

  for (const boardId of ALL_QUOTE_BOARD_IDS) {
    const found = await searchBoardByPhone(boardId, phoneVariants)
    if (found) return found
  }
  return null
}


// ── Pipeline A: update existing item's columns ──────────────────────────

export interface QuoteUpdatePayload {
  quoteValueIncGst: number       // → COLUMNS.QUOTE_VALUE
  quoteDateIso: string           // → COLUMNS.DATE (YYYY-MM-DD form taken from this)
  // Optional — set if available
  email?: string | null          // → COLUMNS.EMAIL  (overwrite if PDF has it)
  postcode?: string | null       // → COLUMNS.POSTCODE
  // Future: quote number column (need to add to boards first per design §15)
}

/**
 * Update the quote-related columns on an existing Monday item. Caller has
 * already confirmed the item exists (via findItemByPhone). We don't change
 * the status, group, or owner — leaving the rep's workflow alone.
 *
 * Uses change_multiple_column_values so we get atomic write semantics —
 * either all the columns update or none do (Monday rolls back on error).
 */
export async function updateItemColumns(
  itemId: string,
  boardId: string,
  payload: QuoteUpdatePayload,
): Promise<void> {
  const columnValues: Record<string, any> = {}

  // Numeric column wants a string in Monday's column-values JSON
  columnValues[COLUMNS.QUOTE_VALUE] = String(payload.quoteValueIncGst)

  // Date column wants { date: "YYYY-MM-DD" }
  const dateOnly = new Date(payload.quoteDateIso).toISOString().substring(0, 10)
  columnValues[COLUMNS.DATE] = { date: dateOnly }

  if (payload.email) columnValues[COLUMNS.EMAIL] = payload.email
  if (payload.postcode) columnValues[COLUMNS.POSTCODE] = payload.postcode

  await mondayQuery(
    `mutation UpdateColumns($itemId: ID!, $boardId: ID!, $values: JSON!) {
      change_multiple_column_values(
        item_id: $itemId
        board_id: $boardId
        column_values: $values
        create_labels_if_missing: false
      ) { id }
    }`,
    {
      itemId,
      boardId,
      values: JSON.stringify(columnValues),
    },
  )
}


// ── Pipeline A: bump Contact Attempts counter ───────────────────────────

/**
 * Read the current Contact Attempts value, increment by 1, write back.
 * Self-heals across boards by resolving the column ID per board at runtime
 * (James and Tyronne have different IDs to the original 3 boards).
 *
 * No-op if the column doesn't exist on a particular board, or if any of
 * the GraphQL calls fail (we log a warning and return). Bumping the
 * counter is best-effort — the upstream caller has already done the
 * primary work (item match + column updates) and we don't want a counter
 * problem to throw and cancel that.
 *
 * Race condition note: read-modify-write is not atomic. If two quotes
 * arrive within seconds we may double-count by one. Acceptable given
 * the rate of inbound quotes (low single digits per hour).
 */
export async function bumpContactAttempts(itemId: string, boardId: string): Promise<void> {
  try {
    const colId = await getContactAttemptsColumnId(boardId)
    if (!colId) {
      // Column doesn't exist on this board — silent no-op.
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

    const cv = cur.items?.[0]?.column_values?.[0]
    if (!cv) return

    const curNum = parseInt(cv.text || '', 10) || 0
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
    console.warn(`bumpContactAttempts on board ${boardId}, item ${itemId} failed: ${e?.message || e}`)
  }
}


// ── Pipeline A: upload quote PDF to file column ─────────────────────────
//
// Monday's add_file_to_column requires multipart/form-data, NOT JSON.
// This is the only place in the codebase that doesn't go through
// mondayQuery — file upload uses a different endpoint shape entirely.
//
// File column ID is per-board because file columns aren't on the standard
// template — they were added later. Caller passes the column ID explicitly
// (Pipeline A reads it from a per-board mapping).

const MONDAY_FILE_UPLOAD_URL = 'https://api.monday.com/v2/file'

export interface FileUploadInput {
  itemId: string
  fileColumnId: string           // e.g. 'file_mkxxxxx' — varies per board
  fileBase64: string             // base64-encoded PDF, no data: prefix
  filename: string               // e.g. 'Quote-12345.pdf' (shown in Monday UI)
}

export async function addFileToColumn(input: FileUploadInput): Promise<{ assetId: string }> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not configured')

  // The mutation goes in the `query` form field. The variables go in `variables`.
  // The actual file is sent under a key referenced from inside variables (here: `variables[$file]`).
  const query = `mutation AddFile($itemId: ID!, $columnId: String!, $file: File!) {
    add_file_to_column(item_id: $itemId, column_id: $columnId, file: $file) {
      id
    }
  }`

  const variables = {
    itemId: input.itemId,
    columnId: input.fileColumnId,
    file: null,                 // placeholder — populated via map[] below
  }

  // Decode base64 → Buffer → Blob. Node 18+ has Blob in the global scope on Vercel.
  const buf = Buffer.from(input.fileBase64, 'base64')
  const blob = new Blob([buf], { type: 'application/pdf' })

  const form = new FormData()
  form.append('query', query)
  form.append('variables', JSON.stringify(variables))
  // The map tells Monday which form field corresponds to which variable.
  // Format: { "<form-field-name>": ["variables.<path>"] }
  form.append('map', JSON.stringify({ '0': ['variables.file'] }))
  form.append('0', blob, input.filename)

  const r = await fetch(MONDAY_FILE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'API-Version': '2024-01',
      // NB: do NOT set Content-Type — fetch will set the multipart boundary.
    },
    body: form,
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Monday file upload ${r.status}: ${errText.substring(0, 500)}`)
  }
  const data = await r.json()
  if (data.errors) {
    throw new Error(`Monday file upload GraphQL: ${JSON.stringify(data.errors).substring(0, 500)}`)
  }

  return { assetId: data.data?.add_file_to_column?.id }
}

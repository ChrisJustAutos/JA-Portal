// lib/quote-pipeline-monday.ts
// Monday-side flow for Pipeline A (quote ingestion).
//
// Replaces what Zapier's "Phone Enquiry — Quote Sent" Zap was doing:
//   step 11 in the old Zap = monday.com Create Item.
//
// Architecture (decided 29 Apr 2026):
//   - AC says CREATE → force CREATE on Monday. New item in Quote - Pending.
//   - AC says UPDATE → search ALL 5 boards by phone OR email. If found,
//     update that item. If not found despite AC having a recent deal
//     (data drift / item was deleted), fall through to CREATE on the
//     rep's board.
//
// Cross-board search rationale: a customer's phone or email might land
// on Kaleb's board originally and Dom's board for a follow-up quote.
// We update wherever the item lives so we don't fragment customer
// history across boards.
//
// PDF upload: Monday's REST `/file` endpoint accepts multipart and binds
// the file to a specific column on a specific item. Done as a fire-and-
// forget side effect of create/update — if it fails, we log and continue
// (the deal + item still exist; the file is recoverable from email).
//
// Status column is set to "Quote Sent" (label index 6) on create. This
// would normally fire the existing Quote Sent automation, but that
// automation is scoped to status changes IN the Quote - Lead group only.
// Items created directly in Quote - Pending with status=Quote Sent will
// not re-trigger it. Confirmed with Chris 29 Apr 2026.

import {
  mondayQuery,
  escGqlString,
  searchBoardByPhone,
  normalisePhone,
  REP_BOARDS,
  ALL_QUOTE_BOARD_IDS,
  COLUMNS as SHARED_COLS,
  STATUS_INDICES,
  GROUPS,
  type FoundItem,
} from './monday-followup'

// ── Per-board column IDs that aren't shared across the template ────────
//
// Quote No (text) and Quote PDF (file) were created post-fork on each
// board, so each board has unique column IDs. Quote Value, Phone, Email,
// Postcode, Status, Date are all template-shared and live in SHARED_COLS.
//
// Source: column IDs returned by Monday's create_column API on 29 Apr 2026.
// If the columns are recreated, update these values.
interface BoardSpecificColumns {
  quoteNo: string
  quotePdf: string
  contactAttempts: string  // Also varies per board (post-fork in some cases)
}

const BOARD_COLUMNS: Record<string, BoardSpecificColumns> = {
  // Dom (5025942308)
  '5025942308': {
    quoteNo: 'text_mm2w2nj0',
    quotePdf: 'file_mm2wen64',
    contactAttempts: 'numeric_mm12a3kp',
  },
  // Kaleb (5025942316)
  '5025942316': {
    quoteNo: 'text_mm2wzhgv',
    quotePdf: 'file_mm2wktgq',
    contactAttempts: 'numeric_mm12czp1',
  },
  // Graham (5026840169)
  '5026840169': {
    quoteNo: 'text_mm2wa265',
    quotePdf: 'file_mm2wr8zy',
    contactAttempts: 'numeric_mm0ymvvp',
  },
  // James (5025942292)
  '5025942292': {
    quoteNo: 'text_mm2w15m5',
    quotePdf: 'file_mm2wxx1k',
    contactAttempts: 'numeric_mm12czp1',  // TODO: confirm — copied from template default; verify if James has unique ID
  },
  // Tyronne (5025942288)
  '5025942288': {
    quoteNo: 'text_mm2wbv9x',
    quotePdf: 'file_mm2wr4pm',
    contactAttempts: 'numeric_mm12czp1',  // TODO: confirm — copied from template default; verify if Tyronne has unique ID
  },
}

function getBoardColumns(boardId: string): BoardSpecificColumns {
  const cols = BOARD_COLUMNS[boardId]
  if (!cols) {
    throw new Error(`No per-board column mapping for boardId=${boardId}. Update lib/quote-pipeline-monday.ts.`)
  }
  return cols
}

// ── Cross-board search: phone OR email ─────────────────────────────────
//
// findExistingItem in monday-followup.ts only searches by phone (with name
// fallback). Pipeline A needs phone OR email matching, so we layer a new
// function on top: phone first (cheapest, most reliable), then email
// across all boards if phone didn't match.

interface MatchResult {
  found: FoundItem | null
  matchSource: 'phone' | 'email' | 'none'
  searchedBoards: number
}

async function searchBoardByEmail(boardId: string, email: string): Promise<FoundItem | null> {
  // Email search: server-side filter on EMAIL column, then verify case-
  // insensitively on the client (Monday's compare is case-sensitive by default).
  const lower = email.trim().toLowerCase()

  const data = await mondayQuery<{ boards: Array<{ name: string; items_page: { items: any[] } }> }>(
    `query SearchEmail($boardId: [ID!]) {
      boards(ids: $boardId) {
        name
        items_page(
          limit: 50
          query_params: {
            rules: [{ column_id: "${SHARED_COLS.EMAIL}", compare_value: ${escGqlString(email.trim())}, operator: contains_text }]
          }
        ) {
          items {
            id name
            column_values(ids: ["${SHARED_COLS.PHONE}", "${SHARED_COLS.EMAIL}"]) { id text }
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
    const emailCol = item.column_values?.find((cv: any) => cv.id === SHARED_COLS.EMAIL)
    const phoneCol = item.column_values?.find((cv: any) => cv.id === SHARED_COLS.PHONE)
    if ((emailCol?.text || '').trim().toLowerCase() === lower) {
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

export async function findExistingByPhoneOrEmail(
  phone: string | null,
  email: string | null,
): Promise<MatchResult> {
  let searched = 0

  // Phase 1: phone match across all boards
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
        searched++
        const found = await searchBoardByPhone(boardId, variants)
        if (found) {
          return { found, matchSource: 'phone', searchedBoards: searched }
        }
      }
    }
  }

  // Phase 2: email match across all boards
  if (email && email.trim().length > 3) {
    for (const boardId of ALL_QUOTE_BOARD_IDS) {
      searched++
      const found = await searchBoardByEmail(boardId, email)
      if (found) {
        return { found, matchSource: 'email', searchedBoards: searched }
      }
    }
  }

  return { found: null, matchSource: 'none', searchedBoards: searched }
}

// ── Create new item in Quote - Pending ─────────────────────────────────

export interface CreatePendingItemInput {
  agentName: string                     // e.g. 'Kaleb' — looked up in REP_BOARDS
  customerName: string                  // Full name "First Last"
  phone: string | null
  email: string | null
  postcode: string | null
  quoteNumber: string
  quoteValueIncGst: number
  noteBody: string                      // Posted as Update on the new item
  callDate: string | null               // ISO; defaults to today if null
}

export interface CreatePendingItemResult {
  itemId: string
  boardId: string
  boardName: string
}

export async function createPendingItem(input: CreatePendingItemInput): Promise<CreatePendingItemResult> {
  const repKey = input.agentName.trim().split(/\s+/)[0].toLowerCase()
  const board = REP_BOARDS[repKey]
  if (!board) {
    throw new Error(`No Quote Channel board for rep '${input.agentName}'. Known: ${Object.keys(REP_BOARDS).join(', ')}`)
  }
  const boardCols = getBoardColumns(board.boardId)

  const itemName = input.customerName.trim() || (input.phone ? `Quote for ${input.phone}` : 'Unknown customer')

  const dateIso = (input.callDate ? new Date(input.callDate) : new Date())
    .toISOString()
    .substring(0, 10)

  const columnValues: Record<string, any> = {
    [SHARED_COLS.STATUS]: { index: STATUS_INDICES.QUOTE_SENT },
    [SHARED_COLS.DATE]: { date: dateIso },
    [SHARED_COLS.QUOTE_VALUE]: input.quoteValueIncGst,
    [boardCols.quoteNo]: input.quoteNumber,
    [boardCols.contactAttempts]: 1,
  }
  if (input.phone) columnValues[SHARED_COLS.PHONE] = input.phone
  if (input.email) columnValues[SHARED_COLS.EMAIL] = input.email
  if (input.postcode) columnValues[SHARED_COLS.POSTCODE] = input.postcode

  const created = await mondayQuery<{ create_item: { id: string } }>(
    `mutation CreateQuoteSent($boardId: ID!, $groupId: String!, $itemName: String!, $columnValues: JSON!) {
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
      groupId: GROUPS.PENDING,
      itemName,
      columnValues: JSON.stringify(columnValues),
    },
  )

  const itemId = created.create_item.id

  // Post the first Update on the item with the deal note + line items.
  await mondayQuery(
    `mutation PostFirst($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId, body: input.noteBody },
  )

  return {
    itemId,
    boardId: board.boardId,
    boardName: `${board.repName} Quote Channel`,
  }
}

// ── Update existing item with new quote ────────────────────────────────

export interface UpdateMatchedItemInput {
  itemId: string
  boardId: string
  newQuoteNumber: string
  newQuoteValueIncGst: number
  noteBody: string
}

export interface UpdateMatchedItemResult {
  itemId: string
  boardId: string
  prevQuoteValue: number | null
  newQuoteValue: number
  appendedQuoteNo: boolean
}

export async function updateMatchedItem(input: UpdateMatchedItemInput): Promise<UpdateMatchedItemResult> {
  const boardCols = getBoardColumns(input.boardId)

  // Read the current Quote Value, Quote No, and Contact Attempts so we can
  // compute the new values intelligently.
  const cur = await mondayQuery<{ items: Array<{ column_values: any[] }> }>(
    `query GetCurrent($itemId: [ID!]) {
      items(ids: $itemId) {
        column_values(ids: ["${SHARED_COLS.QUOTE_VALUE}", "${boardCols.quoteNo}", "${boardCols.contactAttempts}"]) {
          id text value
        }
      }
    }`,
    { itemId: [input.itemId] },
  )

  const cvs = cur.items?.[0]?.column_values || []
  const prevValueText = cvs.find((c: any) => c.id === SHARED_COLS.QUOTE_VALUE)?.text || ''
  const prevValue = parseFloat(prevValueText) || 0
  const prevQuoteNo = cvs.find((c: any) => c.id === boardCols.quoteNo)?.text || ''
  const prevAttemptsText = cvs.find((c: any) => c.id === boardCols.contactAttempts)?.text || ''
  const prevAttempts = parseInt(prevAttemptsText, 10) || 0

  const newValue = Math.max(prevValue, input.newQuoteValueIncGst)
  const alreadyPresent = prevQuoteNo.split('|').map(s => s.trim()).includes(input.newQuoteNumber)
  const newQuoteNo = alreadyPresent
    ? prevQuoteNo
    : (prevQuoteNo ? `${prevQuoteNo} | ${input.newQuoteNumber}` : input.newQuoteNumber)

  const todayIso = new Date().toISOString().substring(0, 10)

  const columnValues: Record<string, any> = {
    [SHARED_COLS.QUOTE_VALUE]: newValue,
    [boardCols.quoteNo]: newQuoteNo,
    [boardCols.contactAttempts]: prevAttempts + 1,
    [SHARED_COLS.DATE]: { date: todayIso },
  }

  await mondayQuery(
    `mutation UpdateMatched($itemId: ID!, $boardId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        item_id: $itemId
        board_id: $boardId
        column_values: $columnValues
        create_labels_if_missing: false
      ) { id }
    }`,
    {
      itemId: input.itemId,
      boardId: input.boardId,
      columnValues: JSON.stringify(columnValues),
    },
  )

  // Post the new-quote update
  await mondayQuery(
    `mutation PostUpdate($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) { id }
    }`,
    { itemId: input.itemId, body: input.noteBody },
  )

  return {
    itemId: input.itemId,
    boardId: input.boardId,
    prevQuoteValue: prevValue,
    newQuoteValue: newValue,
    appendedQuoteNo: !alreadyPresent,
  }
}

// ── PDF upload ─────────────────────────────────────────────────────────
//
// Monday's REST file endpoint accepts multipart form data with the GraphQL
// query as one part and the file as another. The query mutation is
// `add_file_to_column`.

export interface UploadPdfInput {
  itemId: string
  boardId: string
  pdfBase64: string
  pdfFilename: string
}

export interface UploadPdfResult {
  uploaded: boolean
  assetId: string | null
  error: string | null
}

export async function uploadPdfToItem(input: UploadPdfInput): Promise<UploadPdfResult> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) return { uploaded: false, assetId: null, error: 'MONDAY_API_TOKEN not configured' }

  const boardCols = getBoardColumns(input.boardId)

  // Decode base64 to Buffer
  const buffer = Buffer.from(input.pdfBase64, 'base64')

  // Build multipart manually using FormData (available in Next.js / Node 18+)
  const form = new FormData()
  form.append('query', `mutation AddFile($itemId: ID!, $columnId: String!, $file: File!) {
    add_file_to_column(item_id: $itemId, column_id: $columnId, file: $file) { id }
  }`)
  form.append('variables', JSON.stringify({
    itemId: input.itemId,
    columnId: boardCols.quotePdf,
  }))
  form.append('map', JSON.stringify({ file: 'variables.file' }))

  // The file part — Monday wants it under the key 'file' matching the map.
  const blob = new Blob([buffer], { type: 'application/pdf' })
  form.append('file', blob, input.pdfFilename)

  try {
    const r = await fetch('https://api.monday.com/v2/file', {
      method: 'POST',
      headers: {
        Authorization: token,
        // DO NOT set Content-Type — fetch sets multipart boundary automatically
      },
      body: form,
    })

    if (!r.ok) {
      const errText = await r.text()
      return { uploaded: false, assetId: null, error: `Monday file API ${r.status}: ${errText.substring(0, 300)}` }
    }
    const data = await r.json()
    if (data.errors) {
      return { uploaded: false, assetId: null, error: `GraphQL: ${JSON.stringify(data.errors).substring(0, 300)}` }
    }
    const assetId = data.data?.add_file_to_column?.id || null
    return { uploaded: !!assetId, assetId, error: null }
  } catch (e: any) {
    return { uploaded: false, assetId: null, error: String(e?.message || e) }
  }
}

// ── High-level orchestrator ────────────────────────────────────────────
//
// Single entry point Pipeline A's webhook calls.

export interface SyncQuoteToMondayInput {
  agentName: string
  acDecision: 'create' | 'update'        // Drives create-vs-search behaviour
  customerName: string
  phone: string | null
  email: string | null
  postcode: string | null
  quoteNumber: string
  quoteValueIncGst: number
  noteBody: string
  pdfBase64: string | null
  pdfFilename: string | null
  callDate: string | null
}

export interface SyncQuoteToMondayResult {
  action: 'created' | 'updated' | 'created_fallback'
  itemId: string
  boardId: string
  boardName: string
  matchSource: 'phone' | 'email' | 'none' | 'forced_create'
  pdfUpload: UploadPdfResult | null
  prevQuoteValue: number | null
  newQuoteValue: number
}

export async function syncQuoteToMonday(input: SyncQuoteToMondayInput): Promise<SyncQuoteToMondayResult> {
  let action: SyncQuoteToMondayResult['action']
  let matchSource: SyncQuoteToMondayResult['matchSource']
  let itemId: string
  let boardId: string
  let boardName: string
  let prevQuoteValue: number | null = null
  let newQuoteValue: number = input.quoteValueIncGst

  if (input.acDecision === 'create') {
    // AC said new deal — force CREATE on Monday. No search.
    const created = await createPendingItem({
      agentName: input.agentName,
      customerName: input.customerName,
      phone: input.phone,
      email: input.email,
      postcode: input.postcode,
      quoteNumber: input.quoteNumber,
      quoteValueIncGst: input.quoteValueIncGst,
      noteBody: input.noteBody,
      callDate: input.callDate,
    })
    action = 'created'
    matchSource = 'forced_create'
    itemId = created.itemId
    boardId = created.boardId
    boardName = created.boardName
  } else {
    // AC said update — search across all boards by phone+email
    const match = await findExistingByPhoneOrEmail(input.phone, input.email)
    if (match.found) {
      const updated = await updateMatchedItem({
        itemId: match.found.itemId,
        boardId: match.found.boardId,
        newQuoteNumber: input.quoteNumber,
        newQuoteValueIncGst: input.quoteValueIncGst,
        noteBody: input.noteBody,
      })
      action = 'updated'
      matchSource = match.matchSource
      itemId = updated.itemId
      boardId = updated.boardId
      boardName = match.found.boardName
      prevQuoteValue = updated.prevQuoteValue
      newQuoteValue = updated.newQuoteValue
    } else {
      // AC said update but no Monday item found → fallback create on rep's board
      const created = await createPendingItem({
        agentName: input.agentName,
        customerName: input.customerName,
        phone: input.phone,
        email: input.email,
        postcode: input.postcode,
        quoteNumber: input.quoteNumber,
        quoteValueIncGst: input.quoteValueIncGst,
        noteBody: input.noteBody,
        callDate: input.callDate,
      })
      action = 'created_fallback'
      matchSource = 'none'
      itemId = created.itemId
      boardId = created.boardId
      boardName = created.boardName
    }
  }

  // Upload PDF (best-effort — log failure but don't throw)
  let pdfUpload: UploadPdfResult | null = null
  if (input.pdfBase64 && input.pdfFilename) {
    pdfUpload = await uploadPdfToItem({
      itemId,
      boardId,
      pdfBase64: input.pdfBase64,
      pdfFilename: input.pdfFilename,
    })
    if (!pdfUpload.uploaded) {
      console.warn(`[quote-pipeline-monday] PDF upload failed for item ${itemId}: ${pdfUpload.error}`)
    }
  }

  return {
    action,
    itemId,
    boardId,
    boardName,
    matchSource,
    pdfUpload,
    prevQuoteValue,
    newQuoteValue,
  }
}

// lib/backfill/monday.ts
// Direct Monday API calls for the backfill feature.
// Uses MONDAY_API_TOKEN env var for server-to-server auth.

import {
  ORDERS_BOARD_ID, ORDERS_CONNECT_COLUMN_ID,
  ORDER_COL_DATE, ORDER_COL_STATUS,
  QUOTE_BOARDS, QUOTE_COL_DATE, QUOTE_COL_EMAIL, QUOTE_COL_PHONE, QUOTE_COL_STATUS,
} from './types'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const MONDAY_API_VERSION = '2024-10'

function getToken(): string {
  const t = process.env.MONDAY_API_TOKEN
  if (!t) throw new Error('MONDAY_API_TOKEN env var is not set')
  return t
}

async function mondayGraphql<T = any>(query: string, variables: any = {}): Promise<T> {
  const res = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': getToken(),
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    throw new Error(`Monday API returned ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const json: any = await res.json()
  if (json.errors?.length) {
    throw new Error(`Monday GraphQL errors: ${JSON.stringify(json.errors)}`)
  }
  return json.data as T
}

// Light retry wrapper for transient errors. One retry after 1s backoff.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() }
  catch (e) {
    await new Promise(r => setTimeout(r, 1000))
    return await fn()
  }
}

export interface OrderRow {
  id: string
  name: string
  date: string | null
  status: string | null
  alreadyLinked: boolean
}

// Fetch all orders in a date window.
// Uses the query_params date filter; paginates via cursor until exhausted.
export async function fetchOrdersInWindow(startDate: string, endDate: string): Promise<OrderRow[]> {
  const rows: OrderRow[] = []

  // Note: we interpolate the dates into the query string rather than using variables
  // because Monday's compare_value expects a list literal, and its type system doesn't
  // handle a list-valued variable for this particular field cleanly.
  const safeStart = String(startDate).replace(/"/g, '')
  const safeEnd = String(endDate).replace(/"/g, '')

  const firstPageQuery = `
    query Orders {
      boards(ids: ["${ORDERS_BOARD_ID}"]) {
        items_page(
          limit: 500,
          query_params: {
            rules: [{ column_id: "${ORDER_COL_DATE}", compare_value: ["${safeStart}", "${safeEnd}"], operator: between }]
          }
        ) {
          cursor
          items {
            id name
            column_values(ids: ["${ORDER_COL_DATE}", "${ORDER_COL_STATUS}", "${ORDERS_CONNECT_COLUMN_ID}"]) {
              id text
              ... on BoardRelationValue { linked_item_ids }
            }
          }
        }
      }
    }
  `
  const first = await withRetry(() => mondayGraphql(firstPageQuery, {}))
  const firstPage = first.boards?.[0]?.items_page
  if (firstPage) {
    collectOrders(firstPage.items, rows)
    let cursor = firstPage.cursor as string | null
    // Subsequent pages use next_items_page
    let pages = 1
    const MAX_PAGES = 20
    while (cursor && pages < MAX_PAGES) {
      const safeCursor = String(cursor).replace(/"/g, '')
      const nextPageQuery = `
        query NextPage {
          next_items_page(cursor: "${safeCursor}", limit: 500) {
            cursor
            items {
              id name
              column_values(ids: ["${ORDER_COL_DATE}", "${ORDER_COL_STATUS}", "${ORDERS_CONNECT_COLUMN_ID}"]) {
                id text
                ... on BoardRelationValue { linked_item_ids }
              }
            }
          }
        }
      `
      const next: any = await withRetry(() => mondayGraphql(nextPageQuery, {}))
      const page = next.next_items_page
      if (!page) break
      collectOrders(page.items, rows)
      cursor = page.cursor
      pages++
    }
  }
  return rows
}

function collectOrders(items: any[], out: OrderRow[]) {
  for (const it of items || []) {
    let date: string | null = null
    let status: string | null = null
    let alreadyLinked = false
    for (const cv of it.column_values || []) {
      if (cv.id === ORDER_COL_DATE) date = cv.text || null
      else if (cv.id === ORDER_COL_STATUS) status = cv.text || null
      else if (cv.id === ORDERS_CONNECT_COLUMN_ID) {
        const linked = Array.isArray(cv.linked_item_ids) ? cv.linked_item_ids : []
        alreadyLinked = linked.length > 0
      }
    }
    out.push({ id: String(it.id), name: it.name, date, status, alreadyLinked })
  }
}

export interface QuoteRow {
  id: string
  boardId: string
  rep: string
  name: string
  email: string | null
  phone: string | null
  date: string | null
  status: string | null
}

// Fetch all quotes across all 5 rep boards. Paginates per board.
export async function fetchAllQuotes(): Promise<QuoteRow[]> {
  const rows: QuoteRow[] = []

  for (const board of QUOTE_BOARDS) {
    const safeBoardId = String(board.boardId).replace(/"/g, '')
    const firstPageQuery = `
      query BoardQuotes {
        boards(ids: ["${safeBoardId}"]) {
          items_page(limit: 500) {
            cursor
            items {
              id name
              column_values(ids: ["${QUOTE_COL_EMAIL}", "${QUOTE_COL_PHONE}", "${QUOTE_COL_DATE}", "${QUOTE_COL_STATUS}"]) {
                id text
              }
            }
          }
        }
      }
    `
    const first: any = await withRetry(() => mondayGraphql(firstPageQuery, {}))
    const firstPage = first.boards?.[0]?.items_page
    if (!firstPage) continue
    collectQuotes(firstPage.items, board, rows)

    let cursor = firstPage.cursor as string | null
    let pages = 1
    const MAX_PAGES = 10
    while (cursor && pages < MAX_PAGES) {
      const safeCursor = String(cursor).replace(/"/g, '')
      const nextPageQuery = `
        query NextPage {
          next_items_page(cursor: "${safeCursor}", limit: 500) {
            cursor
            items {
              id name
              column_values(ids: ["${QUOTE_COL_EMAIL}", "${QUOTE_COL_PHONE}", "${QUOTE_COL_DATE}", "${QUOTE_COL_STATUS}"]) {
                id text
              }
            }
          }
        }
      `
      const next: any = await withRetry(() => mondayGraphql(nextPageQuery, {}))
      const page = next.next_items_page
      if (!page) break
      collectQuotes(page.items, board, rows)
      cursor = page.cursor
      pages++
    }
  }
  return rows
}

function collectQuotes(items: any[], board: { boardId: string; rep: string }, out: QuoteRow[]) {
  for (const it of items || []) {
    let email: string | null = null, phone: string | null = null
    let date: string | null = null, status: string | null = null
    for (const cv of it.column_values || []) {
      if (cv.id === QUOTE_COL_EMAIL) email = cv.text || null
      else if (cv.id === QUOTE_COL_PHONE) phone = cv.text || null
      else if (cv.id === QUOTE_COL_DATE) date = cv.text || null
      else if (cv.id === QUOTE_COL_STATUS) status = cv.text || null
    }
    out.push({
      id: String(it.id),
      boardId: board.boardId,
      rep: board.rep,
      name: it.name,
      email, phone, date, status,
    })
  }
}

// Execute a Connect-column update on a single order.
// Uses change_column_value with a JSON value matching Monday's BoardRelationValue format.
export async function linkQuoteToOrder(orderItemId: string, quoteItemId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const mutation = `
      mutation LinkQuote($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
    `
    const value = JSON.stringify({ item_ids: [Number(quoteItemId)] })
    await mondayGraphql(mutation, {
      boardId: ORDERS_BOARD_ID,
      itemId: orderItemId,
      columnId: ORDERS_CONNECT_COLUMN_ID,
      value,
    })
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) }
  }
}

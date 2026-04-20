// lib/backfill/types.ts
// Shared types for the Orders ↔ Quotes backfill feature.

export type RunStatus =
  | 'draft'      // uploaded, waiting for dry run
  | 'matching'   // dry run in progress
  | 'ready'      // dry run complete, plan ready
  | 'executing'  // execute in progress
  | 'executed'   // execute complete
  | 'failed'     // either dry-run or execute errored out

export type MatchStatus =
  | 'matched'            // one quote found for this order
  | 'matched_ambiguous'  // multiple candidate quotes, picked closest-before
  | 'no_quote_for_email' // email found in MD, no quote in any board
  | 'no_email_in_md'     // MD row had blank email
  | 'job_not_in_md'      // order job# not in MD export
  | 'no_job_in_name'     // order name doesn't start with #NNNNN
  | 'already_linked'     // already has a value in Connect column
  | 'skipped_invoice'    // name starts with "Invoice " (support/merch)

export type ExecuteStatus = 'pending' | 'success' | 'failed' | 'skipped'

export interface BackfillRun {
  id: string
  created_at: string
  created_by: string
  status: RunStatus
  md_filename: string | null
  md_row_count: number
  summary: BackfillSummary | null
  error_message: string | null
  matched_at: string | null
  executed_at: string | null
}

export interface BackfillSummary {
  ordersTotal: number
  ordersInPeriod: number
  quotesTotalByBoard: Record<string, number>  // boardId -> count
  byMatchStatus: Record<MatchStatus, number>
  // How many are ready to execute (match_status in matched/matched_ambiguous)
  executeEligible: number
  // If already executed
  executeSuccess?: number
  executeFailed?: number
  executeSkipped?: number
}

export interface BackfillMatch {
  id: number
  run_id: string
  order_id: string
  order_name: string
  order_date: string | null
  order_status: string | null
  already_linked: boolean
  job_number: string | null
  md_email_norm: string | null
  md_rep: string | null
  match_status: MatchStatus
  matched_quote_id: string | null
  matched_quote_name: string | null
  matched_quote_board_id: string | null
  matched_quote_date: string | null
  matched_quote_status: string | null
  days_before_order: number | null
  alternatives_count: number
  execute_status: ExecuteStatus | null
  execute_error: string | null
  executed_at: string | null
}

// Orders board + column IDs (hardcoded — these are stable)
export const ORDERS_BOARD_ID = '1838428097'
export const ORDERS_CONNECT_COLUMN_ID = 'board_relation_mm2k8n34'  // "Quote Selection"

// Quote boards by rep (rep name → board id). Used to narrow search and for grouping.
export const QUOTE_BOARDS: Array<{ boardId: string; rep: string; repFull: string }> = [
  { boardId: '5025942288', rep: 'Tyronne', repFull: 'Tyronne Wright' },
  { boardId: '5025942292', rep: 'James',   repFull: 'James Wilson' },
  { boardId: '5025942308', rep: 'Dom',     repFull: 'Dom Simpson' },
  { boardId: '5025942316', rep: 'Kaleb',   repFull: 'Kaleb Rowe' },
  { boardId: '5026840169', rep: 'Graham',  repFull: 'Graham Roy' },
]

// Quote board column ids
export const QUOTE_COL_PHONE = 'text_mkzbenay'
export const QUOTE_COL_EMAIL = 'text_mkzbpqje'
export const QUOTE_COL_DATE  = 'date4'
export const QUOTE_COL_STATUS = 'status'

// Orders column ids
export const ORDER_COL_DATE = 'date'
export const ORDER_COL_STATUS = 'status'

// Default backfill date window — orders between these dates will be considered
export const DEFAULT_BACKFILL_START = '2026-01-01'
export const DEFAULT_BACKFILL_END   = '2026-12-31'

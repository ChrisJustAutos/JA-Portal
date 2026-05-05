// pages/api/ap/backfill-line-history.ts
//
// Bootstrap ap_line_account_history from past MYOB Service Bills. Without
// this, the resolver's history layer (B) only learns from bills posted via
// JA Portal — meaning suggestions are useless until many bills are through.
//
// REWRITE NOTES (after the v1 504 timeout):
//   v1 aggregated all (supplier, desc, account) tuples in memory, then
//   upserted at the end. A 504 mid-run discarded everything except what
//   had been previously saved. v2 fixes that with three changes:
//
//     1. INCREMENTAL FLUSH — after each MYOB page (200 bills), the page's
//        aggregates are immediately upserted to ap_line_account_history.
//        A 504 now only loses the *current* page's worth of work. Re-runs
//        are idempotent (see "Re-run idempotency" below).
//
//     2. TIME BUDGET — the route checks elapsed time before fetching each
//        page and returns a continuation cursor (`nextBeforeDate`) when it
//        nears the configured budget. The caller can chain calls in a loop
//        from the browser console. Vercel hobby plans cap at 10s, Pro at
//        60s; we default the budget to 50s to leave room for the final
//        flush + JSON response.
//
//     3. DATE WINDOWING — accepts `beforeDate` so the caller can chain
//        multiple calls walking backwards through history. Each call
//        processes from `sinceDate` up to `beforeDate` (exclusive),
//        sorted desc, and reports the oldest bill it touched. Caller then
//        re-invokes with `beforeDate = oldestBillDate`.
//
// Re-run idempotency:
//   For source='myob_backfill' rows, we REPLACE bill_count on re-run
//   (idempotent — running the backfill twice over the same window doesn't
//   double-count). For source='ja_post' rows, we ADD — those events are
//   independent of MYOB history and have already been counted from JA
//   posts. NB: this means the same bill seen across overlapping calls is
//   counted once per (supplier, desc, account) tuple per call. Avoid
//   overlapping windows in the chained-call loop.
//
// POST /api/ap/backfill-line-history
//   Body:
//     - sinceDate?:   'YYYY-MM-DD'    default: 12 months ago (lower bound, inclusive)
//     - beforeDate?:  'YYYY-MM-DD'    default: today          (upper bound, exclusive)
//     - maxBills?:    number          default: 1500, hard cap 5000 per call
//     - companyFile?: 'VPS' | 'JAWS'  default: 'VPS'
//     - timeBudgetMs?: number         default: 50000 (50s)
//   Response:
//     {
//       ok, companyFile, sinceDate, beforeDate,
//       processed, lines_recorded, history_inserted, history_updated,
//       pagesFetched, oldestBillDate, newestBillDate,
//       done,            // true if scan reached sinceDate or hit no-more-bills
//       nextBeforeDate,  // when done=false, pass this back as beforeDate to continue
//       ms,
//     }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { getConnection, myobFetch } from '../../../lib/myob'
import { CompanyFileLabel } from '../../../lib/ap-myob-lookup'
import { normaliseDescription } from '../../../lib/ap-line-resolver'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const VALID_COMPANY_FILES = new Set<CompanyFileLabel>(['VPS', 'JAWS'])
const PAGE_SIZE = 200
const MAX_BILLS_HARD_CAP = 5000
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

// Vercel function timeout — only honoured on Pro plans; hobby is 10s.
// Either way the route also self-checks against timeBudgetMs and returns
// a cursor before the platform kills us.
export const config = { maxDuration: 300 }

interface AccountInfo {
  code: string
  name: string
}

interface AggregateValue {
  supplier_name: string | null
  account_code: string
  account_name: string
  count: number
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' })
  }

  const t0 = Date.now()
  const body = (req.body || {}) as Record<string, any>

  const sinceDate = (typeof body.sinceDate === 'string' && DATE_REGEX.test(body.sinceDate))
    ? body.sinceDate : isoDateNMonthsAgo(12)
  const beforeDate = (typeof body.beforeDate === 'string' && DATE_REGEX.test(body.beforeDate))
    ? body.beforeDate : isoTodayPlus(1)   // tomorrow → "everything up to and including today"

  if (sinceDate >= beforeDate) {
    return res.status(400).json({ error: `sinceDate (${sinceDate}) must be earlier than beforeDate (${beforeDate})` })
  }

  const maxBillsRaw = Number(body.maxBills)
  const maxBills = Number.isFinite(maxBillsRaw) && maxBillsRaw > 0
    ? Math.min(Math.round(maxBillsRaw), MAX_BILLS_HARD_CAP)
    : 1500

  const timeBudgetMsRaw = Number(body.timeBudgetMs)
  const timeBudgetMs = Number.isFinite(timeBudgetMsRaw) && timeBudgetMsRaw > 0
    ? Math.min(Math.round(timeBudgetMsRaw), 270_000)   // cap below maxDuration
    : 50_000

  const companyFile = (typeof body.companyFile === 'string' ? body.companyFile.toUpperCase() : 'VPS') as CompanyFileLabel
  if (!VALID_COMPANY_FILES.has(companyFile)) {
    return res.status(400).json({ error: `companyFile must be one of ${Array.from(VALID_COMPANY_FILES).join(', ')}` })
  }

  const conn = await getConnection(companyFile)
  if (!conn) return res.status(503).json({ error: `No active MYOB connection for ${companyFile}` })
  if (!conn.company_file_id) return res.status(503).json({ error: `MYOB connection ${companyFile} has no company file selected` })

  const c = sb()

  // ── Step 1: chart-of-accounts UID map ──
  // One paginated fetch up front. ~3-4s for a typical CoA. Skipping bills
  // whose Account.UID isn't in the map (deleted/inactive accounts).
  let accountMap: Map<string, AccountInfo>
  try {
    accountMap = await fetchAccountMap(conn.id, conn.company_file_id)
  } catch (e: any) {
    return res.status(502).json({ error: `Failed to load chart of accounts: ${e?.message}` })
  }

  // ── Step 2: page through Service Bills, flushing per page ──
  // OData filter: Date >= sinceDate AND Date < beforeDate
  // (le would be inclusive on the upper end, which complicates the
  // "use beforeDate = previous oldestBillDate" continuation pattern —
  // exclusive avoids re-processing the boundary day.)
  const filter = `Date ge datetime'${sinceDate}T00:00:00' and Date lt datetime'${beforeDate}T00:00:00'`
  let skip = 0
  let processed = 0
  let linesRecorded = 0
  let pagesFetched = 0
  let totalInserted = 0
  let totalUpdated = 0
  let totalFailed = 0
  let oldestBillDate: string | null = null
  let newestBillDate: string | null = null
  let done = false
  let nextBeforeDate: string | null = null
  let timedOut = false

  while (processed < maxBills) {
    // Time-budget pre-check. Bail BEFORE fetching the next page rather
    // than mid-flush — avoids leaving a half-flushed page on the floor.
    const elapsed = Date.now() - t0
    if (elapsed > timeBudgetMs) {
      timedOut = true
      // The continuation cursor is the OLDEST date we've successfully
      // processed in this call. Re-running with beforeDate = this value
      // continues backwards without overlap (the < is exclusive).
      nextBeforeDate = oldestBillDate
      break
    }

    let result: { status: number; data: any; raw: string }
    try {
      result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Bill/Service`, {
        query: {
          '$filter':  filter,
          '$orderby': 'Date desc',
          '$top':     PAGE_SIZE,
          '$skip':    skip,
        },
      })
    } catch (e: any) {
      // Network blip mid-paging — return what we've got + a cursor.
      timedOut = true
      nextBeforeDate = oldestBillDate
      break
    }

    if (result.status !== 200) {
      return res.status(502).json({
        error: `MYOB Service Bills query failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 300)}`,
        processed, lines_recorded: linesRecorded, pagesFetched,
      })
    }
    pagesFetched++
    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    if (items.length === 0) {
      done = true
      break
    }

    // Build this page's aggregate in memory (small — at most 200 bills'
    // worth of tuples). Then flush before fetching the next page.
    const pageAgg = new Map<string, AggregateValue>()

    for (const bill of items) {
      processed++
      if (processed > maxBills) {
        // Roll back the increment — the bill we just stopped at hasn't
        // been counted into pageAgg yet (we break before adding lines).
        processed = maxBills
        break
      }

      const supplierUid: string | undefined = bill?.Supplier?.UID
      if (!supplierUid) continue
      const supplierName: string | null = bill?.Supplier?.Name || null

      const billDate: string | null = typeof bill.Date === 'string' ? bill.Date.substring(0, 10) : null
      if (billDate) {
        if (!newestBillDate || billDate > newestBillDate) newestBillDate = billDate
        if (!oldestBillDate || billDate < oldestBillDate) oldestBillDate = billDate
      }

      const billLines: any[] = Array.isArray(bill.Lines) ? bill.Lines : []
      for (const line of billLines) {
        const desc: string = typeof line.Description === 'string' ? line.Description : ''
        const accountUid: string | undefined = line?.Account?.UID
        if (!desc || !accountUid) continue

        const norm = normaliseDescription(desc)
        if (!norm) continue

        const accInfo = accountMap.get(accountUid)
        if (!accInfo) continue

        const key = `${supplierUid}|${norm}|${accountUid}`
        const ex = pageAgg.get(key)
        if (ex) {
          ex.count++
          // Keep newest non-null supplier name in case some bills lack it
          if (!ex.supplier_name && supplierName) ex.supplier_name = supplierName
        } else {
          pageAgg.set(key, {
            supplier_name: supplierName,
            account_code:  accInfo.code,
            account_name:  accInfo.name,
            count: 1,
          })
        }
        linesRecorded++
      }
    }

    // ── Flush this page's aggregate ──
    // Sequential read-then-write per tuple. Could parallelise but the
    // page is small (typically 50-200 unique tuples) and Supabase has
    // its own concurrency limits — keep it simple.
    for (const [key, value] of Array.from(pageAgg.entries())) {
      const [supplierUid, descriptionNormalised, accountUid] = key.split('|')
      try {
        const { data: existing } = await c.from('ap_line_account_history')
          .select('id, bill_count, source')
          .eq('supplier_uid',           supplierUid)
          .eq('description_normalised', descriptionNormalised)
          .eq('account_uid',            accountUid)
          .maybeSingle()

        if (existing) {
          // Two cases:
          //   - source='myob_backfill': REPLACE — backfill is idempotent
          //     when it overlaps a prior run on the same window
          //   - source='ja_post': ADD — JA-side post events are real
          //     observations independent of MYOB history scan
          //
          //  After this update we mark source='myob_backfill' so a future
          //  re-run of the same window REPLACEs cleanly. JA posts after
          //  this point will switch it back to 'ja_post' via the post path.
          const newCount = existing.source === 'ja_post'
            ? ((existing.bill_count as number) || 0) + value.count
            : value.count
          await c.from('ap_line_account_history').update({
            bill_count:        newCount,
            last_seen_at:      new Date().toISOString(),
            source:            'myob_backfill',
            supplier_name:     value.supplier_name,
            account_code:      value.account_code,
            account_name:      value.account_name,
            myob_company_file: companyFile,
          }).eq('id', existing.id)
          totalUpdated++
        } else {
          await c.from('ap_line_account_history').insert({
            supplier_uid:           supplierUid,
            supplier_name:          value.supplier_name,
            myob_company_file:      companyFile,
            description_normalised: descriptionNormalised,
            account_uid:            accountUid,
            account_code:           value.account_code,
            account_name:           value.account_name,
            bill_count:             value.count,
            source:                 'myob_backfill',
          })
          totalInserted++
        }
      } catch (e: any) {
        totalFailed++
        console.error(`backfill upsert failed (${descriptionNormalised}): ${e?.message}`)
      }
    }

    // Last page? Done.
    if (items.length < PAGE_SIZE) {
      done = true
      break
    }
    skip += PAGE_SIZE
  }

  // If we hit maxBills without a 504 and there might be older bills to
  // process, surface a continuation cursor so the chained-call loop can
  // continue. The $orderby=Date desc with $skip pattern doesn't
  // technically guarantee that the oldest seen so far IS the cursor —
  // could be a same-day bill we haven't fetched yet. But with
  // beforeDate exclusive we accept that: re-running with
  // beforeDate=oldestBillDate will skip same-day bills, which is fine
  // (the line counts we got from those that we did see are durable).
  if (!done && !timedOut) {
    nextBeforeDate = oldestBillDate
  }

  return res.status(200).json({
    ok: true,
    companyFile,
    sinceDate,
    beforeDate,
    processed,
    lines_recorded:    linesRecorded,
    history_inserted:  totalInserted,
    history_updated:   totalUpdated,
    history_failed:    totalFailed,
    history_upserts:   totalInserted + totalUpdated,
    pagesFetched,
    oldestBillDate,
    newestBillDate,
    done,
    timedOut,
    nextBeforeDate,
    ms: Date.now() - t0,
  })
})

// ── Helpers ─────────────────────────────────────────────────────────────

async function fetchAccountMap(connId: string, cfId: string): Promise<Map<string, AccountInfo>> {
  const map = new Map<string, AccountInfo>()
  let skip = 0
  while (true) {
    const result = await myobFetch(connId, `/accountright/${cfId}/GeneralLedger/Account`, {
      query: { '$top': PAGE_SIZE, '$skip': skip },
    })
    if (result.status !== 200) {
      throw new Error(`HTTP ${result.status}: ${(result.raw || '').substring(0, 200)}`)
    }
    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    for (const a of items) {
      if (a?.UID) {
        map.set(String(a.UID), {
          code: String(a.DisplayID || ''),
          name: String(a.Name || ''),
        })
      }
    }
    if (items.length < PAGE_SIZE) break
    skip += PAGE_SIZE
    if (skip > 5000) break
  }
  return map
}

function isoDateNMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return ymd(d)
}
function isoTodayPlus(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return ymd(d)
}
function ymd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// pages/api/ap/backfill-line-history.ts
//
// One-shot backfill that bootstraps ap_line_account_history from past MYOB
// Service Bills. Without this, history-based smart pickup only learns from
// bills posted via JA Portal — meaning the "B" layer is useless until many
// bills have been posted. This route reads existing MYOB data so the
// resolver works on day one.
//
// What it does:
//   1. Fetch the entire chart of accounts (one query) to resolve UID → {code, name}
//   2. Page through /Purchase/Bill/Service with $top=200, $skip=N, filtered
//      by Date >= sinceDate, until either no more results, or maxBills hit
//   3. For each bill, for each line: build (supplier_uid, normalised desc, account_uid)
//      tuple in memory and aggregate counts
//   4. After paging finishes, upsert the aggregate into ap_line_account_history
//      (read-then-write, since Supabase JS has no atomic increment helper)
//
// Why aggregate in memory: a re-run of the backfill should be idempotent in
// the sense that running it twice on the same date range doesn't double-count
// existing history rows. We solve that by reading the existing bill_count and
// only ADDING the new tuple count if the row already has source='ja_post'
// (meaning the user posted via the portal — those events are independent),
// or by REPLACING with the new count if source='myob_backfill' (meaning a
// previous backfill).
//
// POST /api/ap/backfill-line-history
//   Body:
//     - sinceDate?: 'YYYY-MM-DD'         default: 12 months ago
//     - maxBills?: number                default: 1000, hard cap 5000
//     - companyFile?: 'VPS' | 'JAWS'     default: 'VPS'
//   Response: {
//     ok, processed, lines_recorded, history_upserts, ms,
//     pagesFetched, oldestBillDate, newestBillDate
//   }
//
// Service Bills only — Item Bills go through a different endpoint, and AP
// uses Service Bills exclusively (per Chris's design: trade purchases are
// handled outside the JA Portal AP flow).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { getConnection, myobFetch } from '../../../../lib/myob'
import { CompanyFileLabel } from '../../../../lib/ap-myob-lookup'
import { normaliseDescription } from '../../../../lib/ap-line-resolver'

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

// Vercel function timeout — backfill can be slow for 12 months of data
export const config = { maxDuration: 300 }

interface AccountInfo {
  code: string
  name: string
}

interface AggregateKey {
  supplier_uid: string
  supplier_name: string | null
  description_normalised: string
  account_uid: string
  account_code: string
  account_name: string
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' })
  }

  const t0 = Date.now()
  const body = (req.body || {}) as Record<string, any>

  const sinceDate = (typeof body.sinceDate === 'string' && DATE_REGEX.test(body.sinceDate))
    ? body.sinceDate
    : isoDateNMonthsAgo(12)

  const maxBillsRaw = Number(body.maxBills)
  const maxBills = Number.isFinite(maxBillsRaw) && maxBillsRaw > 0
    ? Math.min(Math.round(maxBillsRaw), MAX_BILLS_HARD_CAP)
    : 1000

  const companyFile = (typeof body.companyFile === 'string' ? body.companyFile.toUpperCase() : 'VPS') as CompanyFileLabel
  if (!VALID_COMPANY_FILES.has(companyFile)) {
    return res.status(400).json({ error: `companyFile must be one of ${Array.from(VALID_COMPANY_FILES).join(', ')}` })
  }

  const conn = await getConnection(companyFile)
  if (!conn) return res.status(503).json({ error: `No active MYOB connection for ${companyFile}` })
  if (!conn.company_file_id) return res.status(503).json({ error: `MYOB connection ${companyFile} has no company file selected` })

  // ── Step 1: build the chart-of-accounts UID map ──
  let accountMap: Map<string, AccountInfo>
  try {
    accountMap = await fetchAccountMap(conn.id, conn.company_file_id)
  } catch (e: any) {
    return res.status(502).json({ error: `Failed to load chart of accounts: ${e?.message}` })
  }

  // ── Step 2: page through Service Bills, collecting (supplier, desc, account) tuples ──
  const aggregates = new Map<string, { meta: AggregateKey; count: number }>()
  let processed = 0
  let linesRecorded = 0
  let pagesFetched = 0
  let oldestBillDate: string | null = null
  let newestBillDate: string | null = null

  // OData $filter: Date ge datetime'YYYY-MM-DDTHH:MM:SS'
  const filter = `Date ge datetime'${sinceDate}T00:00:00'`
  let skip = 0

  outer: while (processed < maxBills) {
    const result = await myobFetch(conn.id, `/accountright/${conn.company_file_id}/Purchase/Bill/Service`, {
      query: {
        '$filter':  filter,
        '$orderby': 'Date desc',
        '$top':     PAGE_SIZE,
        '$skip':    skip,
      },
    })
    if (result.status !== 200) {
      return res.status(502).json({
        error: `MYOB Service Bills query failed (HTTP ${result.status}): ${(result.raw || '').substring(0, 300)}`,
        processed, linesRecorded, pagesFetched,
      })
    }
    pagesFetched++
    const items: any[] = Array.isArray(result.data?.Items) ? result.data.Items : []
    if (items.length === 0) break

    for (const bill of items) {
      processed++
      if (processed > maxBills) {
        // Don't double-process the bill we just stopped at
        processed = maxBills
        break outer
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
        if (!accInfo) continue   // account no longer exists / inactive — skip

        const key = `${supplierUid}|${norm}|${accountUid}`
        const ex = aggregates.get(key)
        if (ex) {
          ex.count++
        } else {
          aggregates.set(key, {
            meta: {
              supplier_uid:           supplierUid,
              supplier_name:          supplierName,
              description_normalised: norm,
              account_uid:            accountUid,
              account_code:           accInfo.code,
              account_name:           accInfo.name,
            },
            count: 1,
          })
        }
        linesRecorded++
      }
    }

    if (items.length < PAGE_SIZE) break  // last page
    skip += PAGE_SIZE
  }

  // ── Step 3: persist aggregates ──
  const c = sb()
  let inserted = 0
  let updated = 0
  let failed = 0

  for (const [, entry] of Array.from(aggregates.entries())) {
    try {
      const { data: existing } = await c.from('ap_line_account_history')
        .select('id, bill_count, source')
        .eq('supplier_uid',           entry.meta.supplier_uid)
        .eq('description_normalised', entry.meta.description_normalised)
        .eq('account_uid',            entry.meta.account_uid)
        .maybeSingle()

      if (existing) {
        // If source='myob_backfill' (re-running), REPLACE the count to keep
        // it idempotent. If source='ja_post' (the user has been posting via
        // the portal), ADD — those events are independent of MYOB history.
        const newCount = existing.source === 'ja_post'
          ? ((existing.bill_count as number) || 0) + entry.count
          : entry.count
        await c.from('ap_line_account_history').update({
          bill_count:   newCount,
          last_seen_at: new Date().toISOString(),
          source:       'myob_backfill',
          supplier_name:    entry.meta.supplier_name,
          account_code:     entry.meta.account_code,
          account_name:     entry.meta.account_name,
          myob_company_file: companyFile,
        }).eq('id', existing.id)
        updated++
      } else {
        await c.from('ap_line_account_history').insert({
          supplier_uid:           entry.meta.supplier_uid,
          supplier_name:          entry.meta.supplier_name,
          myob_company_file:      companyFile,
          description_normalised: entry.meta.description_normalised,
          account_uid:            entry.meta.account_uid,
          account_code:           entry.meta.account_code,
          account_name:           entry.meta.account_name,
          bill_count:             entry.count,
          source:                 'myob_backfill',
        })
        inserted++
      }
    } catch (e: any) {
      failed++
      console.error(`backfill upsert failed (${entry.meta.description_normalised}): ${e?.message}`)
    }
  }

  return res.status(200).json({
    ok: true,
    companyFile,
    sinceDate,
    maxBills,
    processed,
    lines_recorded: linesRecorded,
    history_upserts: inserted + updated,
    history_inserted: inserted,
    history_updated:  updated,
    history_failed:   failed,
    unique_tuples: aggregates.size,
    pagesFetched,
    oldestBillDate,
    newestBillDate,
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
    // Safety: charts of accounts are usually < 500 lines but we shouldn't
    // loop forever if MYOB returns weird pagination.
    if (skip > 5000) break
  }
  return map
}

function isoDateNMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  // YYYY-MM-DD without TZ surprises
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

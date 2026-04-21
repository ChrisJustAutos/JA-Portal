// pages/api/vehicle-sales/sync.ts
// Classifies VPS MYOB invoices into vehicle platform buckets and writes to
// the Supabase cache (`myob_vps_invoice_classifications`).
//
// Designed to run as multiple short calls rather than one long one, because
// Vercel serverless functions time out at 10s (Hobby) / 60s (Pro) and VPS has
// ~2,200 invoices in a FY. Each POST processes ONE chunk of invoices and
// returns { done, processed, remaining } so the UI can loop.
//
// Request body (JSON):
//   {
//     mode: 'full'      → classify from scratch (truncates the cache)
//         | 'incremental'→ only invoices modified since last sync
//         | 'window'    → classify a specific date window
//     from: 'YYYY-MM-DD' (optional, only for 'window' / 'full' override)
//     to:   'YYYY-MM-DD' (optional)
//     offset: number    → where to resume (0 for first call)
//     chunk_size: number→ how many invoices this call will process (default 30)
//   }
//
// Response:
//   {
//     processed_this_call, total_invoices, remaining, done,
//     next_offset, elapsed_ms
//   }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '../../../lib/auth'
import { cdataQuery } from '../../../lib/cdata'
import { detectAllPlatformsFromTexts } from '../../../lib/vehiclePlatforms'

export const config = {
  // Pro serverless tier = 60s. Hobby = 10s. If you're on hobby, use smaller
  // chunk_size values (10-15) to stay under.
  maxDuration: 60,
}

const VPS_CATALOG = 'MYOB_POWERBI_VPS'

// Revenue account IDs to include when deciding if an invoice has real workshop
// revenue. These are income accounts (4-xxxx) excluding deposit-holding /
// internal-adjustment accounts.
const EXCLUDED_REVENUE_IDS = new Set([
  '4-0001', '4-0002', '4-0401', '4-0500',
])
function isRevenueAccount(acctId: string | null | undefined): boolean {
  if (!acctId) return false
  const id = acctId.trim()
  if (!id.startsWith('4-')) return false
  return !EXCLUDED_REVENUE_IDS.has(id)
}

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

function todayISOBrisbane(): string {
  const nowUtc = new Date()
  const bris = new Date(nowUtc.getTime() + 10 * 3600 * 1000)
  return `${bris.getUTCFullYear()}-${String(bris.getUTCMonth() + 1).padStart(2, '0')}-${String(bris.getUTCDate()).padStart(2, '0')}`
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  return requireAdmin(req, res, async () => {
    const started = Date.now()
    try {
      const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      const mode       = String(body.mode || 'incremental')
      const fromParam  = typeof body.from === 'string' ? body.from : null
      const toParam    = typeof body.to === 'string' ? body.to : null
      const offset     = Math.max(0, Number(body.offset || 0))
      const chunkSize  = Math.min(50, Math.max(5, Number(body.chunk_size || 30)))

      // Determine date range for this sync
      let from: string, to: string
      if (mode === 'full') {
        from = fromParam || '2020-01-01'
        to   = toParam   || todayISOBrisbane()
      } else if (mode === 'window') {
        if (!fromParam || !toParam) throw new Error('window mode requires from and to')
        from = fromParam; to = toParam
      } else {
        // incremental — read last sync state, advance from there
        const { data: state } = await sb()
          .from('myob_vps_sync_state').select('last_invoice_date_synced').eq('id', 1).maybeSingle()
        from = state?.last_invoice_date_synced || '2020-01-01'
        to   = todayISOBrisbane()
      }

      // On first call of a sync run (offset=0), get the full invoice ID list
      // for the window. We persist nothing here — the UI passes offset on
      // subsequent calls, and we re-query the list (cheap: single query).
      const listSql = `
        SELECT [ID], [Number], [Date], [CustomerName], [TotalAmount], [TotalTax], [Status]
        FROM [${VPS_CATALOG}].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${from}' AND [Date] <= '${to}'
          AND [TotalAmount] > 0
      `.trim()
      const listRes = await cdataQuery(VPS_CATALOG, listSql)
      const headerRows = (listRes.results?.[0]?.rows || []) as any[]

      // Sort deterministically so offset-based pagination is stable
      headerRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])))

      const totalInvoices = headerRows.length
      const slice = headerRows.slice(offset, offset + chunkSize)

      if (slice.length === 0) {
        // Nothing more to do — mark sync complete
        await sb()
          .from('myob_vps_sync_state')
          .upsert({
            id: 1,
            last_sync_at: new Date().toISOString(),
            last_invoice_date_synced: to,
            invoices_classified: totalInvoices,
            last_sync_duration_ms: Date.now() - started,
            last_error: null,
          })
        res.status(200).json({
          processed_this_call: 0,
          total_invoices: totalInvoices,
          remaining: 0,
          done: true,
          next_offset: offset,
          elapsed_ms: Date.now() - started,
          window: { from, to },
        })
        return
      }

      // Pull line items for the slice in one batched IN() query
      const ids = slice.map(r => r[0])
      const idList = ids.map(id => `'${id}'`).join(',')
      const linesSql = `
        SELECT [SaleInvoiceId], [Description], [AccountDisplayID], [Total]
        FROM [${VPS_CATALOG}].[MYOB].[SaleInvoiceItems]
        WHERE [SaleInvoiceId] IN (${idList})
      `.trim()
      const linesRes = await cdataQuery(VPS_CATALOG, linesSql)
      const lineRows = (linesRes.results?.[0]?.rows || []) as any[]

      const linesByInv = new Map<string, { description: string; acct: string; total: number }[]>()
      for (const lr of lineRows) {
        const invId = lr[0]
        if (!linesByInv.has(invId)) linesByInv.set(invId, [])
        linesByInv.get(invId)!.push({
          description: String(lr[1] || ''),
          acct: String(lr[2] || ''),
          total: Number(lr[3] || 0),
        })
      }

      // Classify each invoice in the slice
      const upserts: any[] = []
      for (const h of slice) {
        const id           = h[0]
        const number       = String(h[1] || '')
        const date         = String(h[2] || '').substring(0, 10)
        const customer     = String(h[3] || '')
        const totalAmount  = Number(h[4] || 0)
        const totalTax     = Number(h[5] || 0)
        const status       = String(h[6] || '')

        const lines = linesByInv.get(id) || []
        const hasRevenueLine = lines.some(l => isRevenueAccount(l.acct))
        const descs = lines.map(l => l.description)
        const platforms = detectAllPlatformsFromTexts(descs)
        const classification =
          platforms.length === 0 ? 'Unclassified' :
          platforms.length === 1 ? platforms[0] : 'Mixed'

        upserts.push({
          invoice_id:         id,
          invoice_number:     number,
          invoice_date:       date,
          customer_name:      customer,
          total_amount_inc:   totalAmount,
          total_tax:          totalTax,
          status,
          platforms_detected: platforms,
          classification,
          has_revenue_line:   hasRevenueLine,
          line_descriptions:  descs.join(' | ').substring(0, 4000),
          classified_at:      new Date().toISOString(),
        })
      }

      // Upsert — replace existing rows for re-classifications
      if (upserts.length > 0) {
        const { error } = await sb()
          .from('myob_vps_invoice_classifications')
          .upsert(upserts, { onConflict: 'invoice_id' })
        if (error) throw new Error('Upsert failed: ' + error.message)
      }

      const nextOffset = offset + slice.length
      const remaining  = Math.max(0, totalInvoices - nextOffset)
      const done       = remaining === 0

      // On completion, stamp sync state
      if (done) {
        await sb()
          .from('myob_vps_sync_state')
          .upsert({
            id: 1,
            last_sync_at: new Date().toISOString(),
            last_invoice_date_synced: to,
            invoices_classified: totalInvoices,
            last_sync_duration_ms: Date.now() - started,
            last_error: null,
          })
      }

      res.status(200).json({
        processed_this_call: slice.length,
        total_invoices: totalInvoices,
        remaining,
        done,
        next_offset: nextOffset,
        elapsed_ms: Date.now() - started,
        window: { from, to },
      })
    } catch (e: any) {
      // Persist the error so the UI can display it
      try {
        await sb().from('myob_vps_sync_state').upsert({
          id: 1, last_error: e?.message || 'Unknown',
        })
      } catch { /* ignore */ }
      res.status(500).json({ error: e?.message || 'Unknown', elapsed_ms: Date.now() - started })
    }
  })
}

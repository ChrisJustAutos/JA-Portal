// pages/api/vehicle-sales/sync.ts
// Classifies VPS MYOB invoices into vehicle platform buckets and writes to
// the Supabase cache. Designed for Vercel Hobby (10s timeout) — each call
// processes ONE small date window and returns, then the UI advances to the
// next window.
//
// Request body:
//   {
//     mode: 'incremental' | 'full' | 'window'
//     window_from, window_to: 'YYYY-MM-DD' — the date slice to process this call
//     (for 'full' mode, the UI walks windows from 2020-01-01 to today)
//     (for 'incremental' mode, the UI starts from last_invoice_date_synced)
//     (for 'window' mode, a one-off explicit slice)
//     window_days: 14 by default — size of slice in days
//   }
//
// Response:
//   {
//     processed: <count in this slice>,
//     done: <true if we've reached overall_to>,
//     next_window_from, next_window_to: <what the UI should send next>,
//     overall_from, overall_to: <the full range being processed>,
//     elapsed_ms
//   }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin } from '../../../lib/auth'
import { cdataQuery, endDateExclusive } from '../../../lib/cdata'
import { detectAllPlatformsFromTexts } from '../../../lib/vehiclePlatforms'

const VPS_CATALOG = 'MYOB_POWERBI_VPS'

const EXCLUDED_REVENUE_IDS = new Set(['4-0001', '4-0002', '4-0401', '4-0500'])
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

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  return requireAdmin(req, res, async () => {
    const started = Date.now()
    try {
      const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      const mode       = String(body.mode || 'incremental')
      const windowDays = Math.min(60, Math.max(1, Number(body.window_days || 14)))

      // Figure out the OVERALL range and the NEXT WINDOW
      let overallFrom: string
      let overallTo: string
      let windowFrom: string
      let windowTo: string

      if (mode === 'full') {
        // Default full sync starts from start of LAST calendar year so we get
        // ~16 months of data without trawling through 5+ years of history.
        // Override explicitly via overall_from if you want more/less.
        const defaultFullFrom = `${new Date().getUTCFullYear() - 1}-01-01`
        overallFrom = typeof body.overall_from === 'string' ? body.overall_from : defaultFullFrom
        overallTo   = typeof body.overall_to   === 'string' ? body.overall_to   : todayISOBrisbane()
      } else if (mode === 'window') {
        if (!body.window_from || !body.window_to) throw new Error('window mode requires window_from and window_to')
        overallFrom = body.window_from
        overallTo   = body.window_to
      } else {
        // incremental
        const { data: state } = await sb()
          .from('myob_vps_sync_state').select('last_invoice_date_synced').eq('id', 1).maybeSingle()
        overallFrom = state?.last_invoice_date_synced || '2020-01-01'
        overallTo   = todayISOBrisbane()
      }

      // Next slice to process — defaults to overall_from on first call
      windowFrom = typeof body.window_from === 'string' ? body.window_from : overallFrom
      // Clamp windowFrom to overallFrom if client sent something older
      if (windowFrom < overallFrom) windowFrom = overallFrom

      // Compute windowTo = min(windowFrom + windowDays, overallTo)
      const proposedTo = addDaysISO(windowFrom, windowDays - 1)
      windowTo = proposedTo > overallTo ? overallTo : proposedTo

      // If windowFrom is already past overallTo, we're done
      if (windowFrom > overallTo) {
        await sb()
          .from('myob_vps_sync_state')
          .upsert({
            id: 1,
            last_sync_at: new Date().toISOString(),
            last_invoice_date_synced: overallTo,
            last_sync_duration_ms: Date.now() - started,
            last_error: null,
          })
        res.status(200).json({
          processed: 0, done: true,
          next_window_from: overallTo, next_window_to: overallTo,
          overall_from: overallFrom, overall_to: overallTo,
          elapsed_ms: Date.now() - started,
        })
        return
      }

      // 1. Fetch invoice HEADERS in this window
      const headersSql = `
        SELECT [ID], [Number], [Date], [CustomerName], [TotalAmount], [TotalTax], [Status]
        FROM [${VPS_CATALOG}].[MYOB].[SaleInvoices]
        WHERE [Date] >= '${windowFrom}' AND [Date] < '${endDateExclusive(windowTo)}'
          AND [TotalAmount] > 0
      `.trim()
      const hRes = await cdataQuery(VPS_CATALOG, headersSql)
      const headers = (hRes.results?.[0]?.rows || []) as any[]

      let upserts: any[] = []

      if (headers.length > 0) {
        // 2. Batched line-items query. Limit to 100 IDs per query to stay
        //    well under CData's URL/SQL length limits. With windowDays=14 we
        //    typically see 50-100 headers so usually a single lines query.
        const ids = headers.map(r => r[0])
        const linesByInv = new Map<string, { description: string; acct: string }[]>()

        const BATCH = 100
        for (let i = 0; i < ids.length; i += BATCH) {
          const chunk = ids.slice(i, i + BATCH)
          const idList = chunk.map(id => `'${id}'`).join(',')
          const linesSql = `
            SELECT [SaleInvoiceId], [Description], [AccountDisplayID]
            FROM [${VPS_CATALOG}].[MYOB].[SaleInvoiceItems]
            WHERE [SaleInvoiceId] IN (${idList})
          `.trim()
          const lRes = await cdataQuery(VPS_CATALOG, linesSql)
          for (const lr of (lRes.results?.[0]?.rows || []) as any[]) {
            const invId = lr[0]
            if (!linesByInv.has(invId)) linesByInv.set(invId, [])
            linesByInv.get(invId)!.push({
              description: String(lr[1] || ''),
              acct:        String(lr[2] || ''),
            })
          }
        }

        // 3. Classify
        for (const h of headers) {
          const id           = h[0]
          const number       = String(h[1] || '')
          const date         = String(h[2] || '').substring(0, 10)
          const customer     = String(h[3] || '')
          const totalAmount  = Number(h[4] || 0)
          const totalTax     = Number(h[5] || 0)
          const status       = String(h[6] || '')
          const lines        = linesByInv.get(id) || []

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

        if (upserts.length > 0) {
          const { error } = await sb()
            .from('myob_vps_invoice_classifications')
            .upsert(upserts, { onConflict: 'invoice_id' })
          if (error) throw new Error('Upsert failed: ' + error.message)
        }
      }

      // 4. Decide next window
      const reachedEnd = windowTo >= overallTo
      const nextWindowFrom = reachedEnd ? overallTo : addDaysISO(windowTo, 1)
      const nextWindowTo   = reachedEnd ? overallTo : addDaysISO(nextWindowFrom, windowDays - 1)

      if (reachedEnd) {
        // Tally total classified for state
        const { count } = await sb()
          .from('myob_vps_invoice_classifications')
          .select('invoice_id', { count: 'exact', head: true })

        await sb()
          .from('myob_vps_sync_state')
          .upsert({
            id: 1,
            last_sync_at: new Date().toISOString(),
            last_invoice_date_synced: overallTo,
            invoices_classified: count ?? 0,
            last_sync_duration_ms: Date.now() - started,
            last_error: null,
          })
      }

      res.status(200).json({
        processed: upserts.length,
        done: reachedEnd,
        next_window_from: nextWindowFrom,
        next_window_to:   nextWindowTo,
        overall_from:     overallFrom,
        overall_to:       overallTo,
        window_from:      windowFrom,
        window_to:        windowTo,
        elapsed_ms:       Date.now() - started,
      })
    } catch (e: any) {
      try {
        await sb().from('myob_vps_sync_state').upsert({
          id: 1, last_error: e?.message || 'Unknown',
        })
      } catch { /* ignore */ }
      res.status(500).json({ error: e?.message || 'Unknown', elapsed_ms: Date.now() - started })
    }
  })
}

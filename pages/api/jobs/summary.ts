// pages/api/jobs/summary.ts
// Unified summary of the current Mechanics Desk job report. Powers both
// the /jobs page (full breakdown) and the overview dashboard widgets
// (open count, forecast revenue, types donut, list).
//
// Response shape:
//   {
//     hasReport: boolean,
//     report: { id, uploaded_at, filename, row_count, notes } | null,
//     counts: { total, open, closed },
//     forecast: { open_estimated_total, has_any_estimated, open_without_estimates },
//     byType:   [{ label, count, open_count, estimated_total }],
//     byStatus: [{ label, count }],
//     openJobs: [ { job_number, customer_name, vehicle, status, job_type, estimated_total, opened_date } ]
//   }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// "Open" = anything that isn't closed/invoiced/complete (case-insensitive). We're
// permissive because Mechanics Desk statuses vary between accounts.
function isClosed(status: string | null | undefined): boolean {
  if (!status) return false
  const s = status.toLowerCase()
  return s.includes('closed') || s.includes('invoiced') || s.includes('complete') || s === 'done' || s === 'finished'
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return }
  return requireAuth(req, res, async () => {
    try {
      const { data: run } = await sb()
        .from('job_report_runs')
        .select('id, uploaded_at, filename, row_count, notes')
        .eq('is_current', true)
        .maybeSingle()

      if (!run?.id) {
        res.status(200).json({
          hasReport: false,
          report: null,
          counts:   { total: 0, open: 0, closed: 0 },
          forecast: { open_estimated_total: 0, has_any_estimated: false, open_without_estimates: 0 },
          byType:   [],
          byStatus: [],
          openJobs: [],
        })
        return
      }

      // Pull all rows for this run. Even for large workshops a single MD export
      // is ~hundreds of rows, so one query is fine.
      const { data: jobs, error } = await sb()
        .from('job_report_jobs')
        .select('job_number, customer_name, vehicle, status, job_type, estimated_total, opened_date, closed_date')
        .eq('run_id', run.id)
        .order('opened_date', { ascending: false, nullsFirst: false })
      if (error) throw new Error(error.message)

      const all = (jobs || []) as any[]

      let open = 0
      let closed = 0
      let openEstimatedTotal = 0
      let hasAnyEstimated = false
      let openWithoutEstimates = 0

      const byTypeMap = new Map<string, { label: string, count: number, open_count: number, estimated_total: number }>()
      const byStatusMap = new Map<string, { label: string, count: number }>()
      const openJobs: any[] = []

      for (const j of all) {
        const openFlag = !isClosed(j.status)
        if (openFlag) open++; else closed++

        const typeLabel = (j.job_type && String(j.job_type).trim()) || '(no type)'
        if (!byTypeMap.has(typeLabel)) byTypeMap.set(typeLabel, { label: typeLabel, count: 0, open_count: 0, estimated_total: 0 })
        const tRow = byTypeMap.get(typeLabel)!
        tRow.count++
        if (openFlag) tRow.open_count++

        const est = Number(j.estimated_total || 0)
        if (j.estimated_total !== null && j.estimated_total !== undefined && est > 0) hasAnyEstimated = true
        if (openFlag) {
          if (est > 0) {
            openEstimatedTotal += est
            tRow.estimated_total += est
          } else {
            openWithoutEstimates++
          }
        }

        const statusLabel = (j.status && String(j.status).trim()) || '(no status)'
        if (!byStatusMap.has(statusLabel)) byStatusMap.set(statusLabel, { label: statusLabel, count: 0 })
        byStatusMap.get(statusLabel)!.count++

        if (openFlag) {
          openJobs.push({
            job_number:      j.job_number,
            customer_name:   j.customer_name,
            vehicle:         j.vehicle,
            status:          j.status,
            job_type:        j.job_type,
            estimated_total: j.estimated_total,
            opened_date:     j.opened_date,
          })
        }
      }

      const byType   = Array.from(byTypeMap.values()).sort((a, b) => b.count - a.count)
      const byStatus = Array.from(byStatusMap.values()).sort((a, b) => b.count - a.count)

      res.status(200).json({
        hasReport: true,
        report: run,
        counts:   { total: all.length, open, closed },
        forecast: {
          open_estimated_total: Math.round(openEstimatedTotal * 100) / 100,
          has_any_estimated:    hasAnyEstimated,
          open_without_estimates: openWithoutEstimates,
        },
        byType,
        byStatus,
        openJobs,
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}

// pages/api/jobs/summary.ts
// Forecast-by-month summary of the current Mechanics Desk job report.
//
// Definition: a job contributes to the forecast if
//   • opened_date (Job Date) is >= today (Brisbane), AND
//   • estimated_total (Total) is > 0

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

// Today's YYYY-MM-DD in Brisbane (UTC+10, no DST). Matches parser logic.
function todayBrisbaneISO(): string {
  const nowUtc = new Date()
  const bris = new Date(nowUtc.getTime() + 10 * 3600 * 1000)
  return `${bris.getUTCFullYear()}-${String(bris.getUTCMonth() + 1).padStart(2, '0')}-${String(bris.getUTCDate()).padStart(2, '0')}`
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`
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
          forecast: { total: 0, job_count: 0, future_jobs_total: 0, by_month: [] },
        })
        return
      }

      const { data: jobs, error } = await sb()
        .from('job_report_jobs')
        .select('job_number, customer_name, vehicle, job_type, estimated_total, opened_date, vehicle_platform')
        .eq('run_id', run.id)
        .order('opened_date', { ascending: true, nullsFirst: false })
      if (error) throw new Error(error.message)

      const today = todayBrisbaneISO()
      const byMonth = new Map<string, {
        key: string; label: string; total: number; job_count: number; jobs: any[]
      }>()
      const byPlatform = new Map<string, {
        key: string; label: string; total: number; job_count: number;
      }>()

      let grandTotal = 0
      let contribCount = 0
      let futureJobsTotal = 0

      for (const j of (jobs || []) as any[]) {
        if (!j.opened_date || j.opened_date < today) continue
        futureJobsTotal++

        const est = Number(j.estimated_total || 0)
        if (est <= 0) continue  // only jobs with a dollar value contribute to the forecast

        const platform = j.vehicle_platform || 'Other'

        const key = j.opened_date.substring(0, 7)  // YYYY-MM
        if (!byMonth.has(key)) {
          byMonth.set(key, { key, label: monthLabel(key), total: 0, job_count: 0, jobs: [] })
        }
        const bucket = byMonth.get(key)!
        bucket.total += est
        bucket.job_count++
        bucket.jobs.push({
          job_number:      j.job_number,
          customer_name:   j.customer_name,
          vehicle:         j.vehicle,
          job_type:        j.job_type,
          opened_date:     j.opened_date,
          estimated_total: est,
          vehicle_platform: platform,
        })

        if (!byPlatform.has(platform)) {
          byPlatform.set(platform, { key: platform, label: platform, total: 0, job_count: 0 })
        }
        const pb = byPlatform.get(platform)!
        pb.total += est
        pb.job_count++

        grandTotal += est
        contribCount++
      }

      const byMonthSorted = Array.from(byMonth.values()).sort((a, b) => a.key.localeCompare(b.key))
      for (const m of byMonthSorted) {
        m.jobs.sort((a: any, b: any) => String(a.opened_date).localeCompare(String(b.opened_date)))
        m.total = Math.round(m.total * 100) / 100
      }

      const byPlatformSorted = Array.from(byPlatform.values())
        .map(p => ({ ...p, total: Math.round(p.total * 100) / 100 }))
        .sort((a, b) => b.total - a.total)  // largest first

      res.status(200).json({
        hasReport: true,
        report: run,
        forecast: {
          total:             Math.round(grandTotal * 100) / 100,
          job_count:         contribCount,
          future_jobs_total: futureJobsTotal,
          by_month:          byMonthSorted,
          by_platform:       byPlatformSorted,
        },
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}

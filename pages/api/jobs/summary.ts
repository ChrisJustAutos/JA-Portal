// pages/api/jobs/summary.ts
// Forecast-by-month summary of the current Mechanics Desk Job Report.
//
// Reads ONLY from report_type='forecast' lane. The wip_snapshot lane (Pipeline C
// auto-imports of the daily WIP report) is deliberately excluded — its export
// schema is too thin (missing Job Date, real Job Types, Total). The rich
// data flows in via either:
//   • Manual upload at Settings → Data Imports
//   • GitHub Actions auto-pull (Playwright on a 2-hour cron) hitting this same
//     ingestion path with a service token
//
// A job contributes to the forecast iff:
//   • opened_date (Job Date) >= today (Brisbane), AND
//   • estimated_total > 0
//
// Future-dated jobs without a Total are surfaced separately as a counter.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

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

// Mechanics Desk "Job Types" tags often have a vehicle-platform prefix like
// "VDJ79 - NPC 1600Nm Clutch". For the Type breakdown panel we want a SHORTER
// label without the prefix. Strip prefixes that match a known platform code
// pattern: word(s), optional digit/asterisk, then " - ".
function shortJobType(raw: string | null): string {
  if (!raw) return 'Other'
  const s = raw.trim()
  // Examples handled:
  //   "VDJ79 - NPC 1600Nm Clutch"  → "NPC 1600Nm Clutch"
  //   "GM - Diagnostic"            → "Diagnostic"
  //   "Hilux 1GD - Just Auto's..." → "Just Auto's..."
  //   "GDJ70* - Remap"             → "Remap"
  //   "REM - Remap Update"         → "Remap Update"
  // Doesn't strip non-platform prefixes ("DA - Deposit Applied" stays as-is
  // because DA is rarely the primary type after primaryJobType filtering).
  const m = s.match(/^[A-Za-z][A-Za-z0-9*\s/]{0,15}\s+-\s+(.+)$/)
  if (m) return m[1].trim()
  return s
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return }
  return requireAuth(req, res, async () => {
    try {
      // Forecast lane only — never reads from wip_snapshot.
      const { data: run } = await sb()
        .from('job_report_runs')
        .select('id, uploaded_at, filename, row_count, notes, source, report_type')
        .eq('is_current', true)
        .eq('report_type', 'forecast')
        .maybeSingle()

      // Org-wide monthly target
      const { data: targetRow } = await sb()
        .from('app_settings')
        .select('value')
        .eq('key', 'forecasting_monthly_target')
        .maybeSingle()
      const targetMonthly = Number(targetRow?.value || 0)

      if (!run?.id) {
        res.status(200).json({
          hasReport: false,
          report: null,
          forecast: {
            total: 0, job_count: 0,
            future_jobs_total: 0, jobs_without_total: 0,
            by_month: [], by_platform: [], by_job_type: [],
            target_monthly: targetMonthly,
          },
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

      const byMonth = new Map<string, { key: string; label: string; total: number; job_count: number; jobs: any[] }>()
      const byPlatform = new Map<string, { key: string; label: string; total: number; job_count: number }>()
      const byJobType  = new Map<string, { key: string; label: string; total: number; job_count: number }>()

      let grandTotal = 0
      let contribCount = 0
      let futureJobsTotal = 0
      let jobsWithoutTotal = 0

      for (const j of (jobs || []) as any[]) {
        if (!j.opened_date || j.opened_date < today) continue
        futureJobsTotal++

        const est = Number(j.estimated_total || 0)
        if (est <= 0) {
          jobsWithoutTotal++
          continue
        }

        const platform = j.vehicle_platform || 'Other'
        const jobType  = shortJobType(j.job_type)

        const key = j.opened_date.substring(0, 7)
        if (!byMonth.has(key)) {
          byMonth.set(key, { key, label: monthLabel(key), total: 0, job_count: 0, jobs: [] })
        }
        const bucket = byMonth.get(key)!
        bucket.total += est
        bucket.job_count++
        bucket.jobs.push({
          job_number:       j.job_number,
          customer_name:    j.customer_name,
          vehicle:          j.vehicle,
          job_type:         j.job_type,
          job_type_short:   jobType,
          opened_date:      j.opened_date,
          estimated_total:  est,
          vehicle_platform: platform,
        })

        if (!byPlatform.has(platform)) {
          byPlatform.set(platform, { key: platform, label: platform, total: 0, job_count: 0 })
        }
        const pb = byPlatform.get(platform)!
        pb.total += est; pb.job_count++

        if (!byJobType.has(jobType)) {
          byJobType.set(jobType, { key: jobType, label: jobType, total: 0, job_count: 0 })
        }
        const jb = byJobType.get(jobType)!
        jb.total += est; jb.job_count++

        grandTotal += est; contribCount++
      }

      const byMonthSorted = Array.from(byMonth.values()).sort((a, b) => a.key.localeCompare(b.key))
      for (const m of byMonthSorted) {
        m.jobs.sort((a: any, b: any) => String(a.opened_date).localeCompare(String(b.opened_date)))
        m.total = Math.round(m.total * 100) / 100
      }

      const round2 = (n: number) => Math.round(n * 100) / 100
      const byPlatformSorted = Array.from(byPlatform.values()).map(p => ({ ...p, total: round2(p.total) })).sort((a, b) => b.total - a.total)
      const byJobTypeSorted  = Array.from(byJobType.values()).map(p => ({ ...p, total: round2(p.total) })).sort((a, b) => b.total - a.total)

      res.status(200).json({
        hasReport: true,
        report: run,
        forecast: {
          total:              round2(grandTotal),
          job_count:          contribCount,
          future_jobs_total:  futureJobsTotal,
          jobs_without_total: jobsWithoutTotal,
          by_month:           byMonthSorted,
          by_platform:        byPlatformSorted,
          by_job_type:        byJobTypeSorted,
          target_monthly:     targetMonthly,
        },
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message || 'Unknown' })
    }
  })
}

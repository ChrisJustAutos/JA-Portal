// pages/api/workshop/reports.ts
// GET ?type=daily_sales|received_payments|wip|income_summary|stock|tech_productivity
//     &from=YYYY-MM-DD&to=YYYY-MM-DD (Brisbane dates, inclusive)
//     &format=csv → text/csv download
// Requires view:diary AND view:reports — the floor-level `workshop` role can
// see the diary but not dollar reporting.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { runWorkshopReport, WORKSHOP_REPORT_TYPES, WorkshopReportType } from '../../../lib/workshop-reports'
import { ymdBrisbane } from '../../../lib/workshop'

export const config = { maxDuration: 30 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function csvEscape(v: any): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const YMD = /^\d{4}-\d{2}-\d{2}$/

export default withAuth('view:diary', async (req, res, user) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  if (!roleHasPermission(user.role, 'view:reports')) return res.status(403).json({ error: 'Reports are not available for this role' })

  const type = String(req.query.type || 'daily_sales') as WorkshopReportType
  if (!WORKSHOP_REPORT_TYPES.some(t => t.id === type)) return res.status(400).json({ error: 'unknown report type' })

  const today = ymdBrisbane(new Date())
  const from = String(req.query.from || today)
  const to = String(req.query.to || today)
  if (!YMD.test(from) || !YMD.test(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' })
  if (from > to) return res.status(400).json({ error: 'from must be on or before to' })

  try {
    const result = await runWorkshopReport(sb(), type, from, to)

    if (String(req.query.format || '') === 'csv') {
      const lines = [result.columns.map(c => csvEscape(c.label)).join(',')]
      for (const r of result.rows) lines.push(result.columns.map(c => csvEscape(r[c.key])).join(','))
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="workshop-${type}-${from}-${to}.csv"`)
      return res.status(200).send(lines.join('\n'))
    }

    return res.status(200).json(result)
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'report failed' })
  }
})

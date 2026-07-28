// pages/api/reports/sales-recap/md-refresh.ts
//
// Intraday MechanicDesk refresh for the Sales Report. The GH-Actions runner
// (sales-recap.yml, every ~2h on trading days) scrapes the MD diary notes +
// forward job-report forecast and POSTs them here; we update ONLY the stored
// md_inputs on the current report row — no re-render, no email, weekly report
// payload untouched. The live view (live.ts) re-assembles against these on
// every page load, so forecast/diary stay current as advisors book jobs in
// (Chris 2026-07-28).
//
// Auth: X-Service-Token (scope 'stocktake:write') OR Bearer CRON_SECRET.
// Body: { diaryNotes: [...], forecast: [...] }

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../../lib/service-auth'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cronOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!cronOk && !(await validateServiceToken(req, 'stocktake:write'))) {
    return res.status(401).json({ error: 'Unauthorised' })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const diaryNotes = Array.isArray(body.diaryNotes) ? body.diaryNotes : []
  const forecast = Array.isArray(body.forecast) ? body.forecast : []
  if (!forecast.length && !diaryNotes.length) return res.status(400).json({ error: 'diaryNotes and/or forecast required' })

  const c = sb()
  const { data: cur } = await c.from('sales_recap_reports')
    .select('week_start').eq('is_current', true)
    .order('generated_at', { ascending: false }).limit(1).maybeSingle()
  if (!cur) return res.status(200).json({ ok: false, note: 'no current report row yet — run the weekly generate first' })

  const { error } = await c.from('sales_recap_reports')
    .update({ md_inputs: { diaryNotes, forecast, scrapedAt: new Date().toISOString() } })
    .eq('week_start', cur.week_start)
  if (error) return res.status(500).json({ error: error.message })

  return res.status(200).json({ ok: true, diaryNotes: diaryNotes.length, forecastMonths: forecast.length })
}

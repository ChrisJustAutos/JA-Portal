// pages/api/backfill/runs/[id]/csv.ts
// GET — download all matches for a run as CSV. Admin only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'

export const config = { maxDuration: 60 }

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

// Minimal CSV escape — quote values containing comma/newline/quote, double embedded quotes
function csvEscape(v: any): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

async function handler(req: NextApiRequest, res: NextApiResponse, _user: any) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const { id } = req.query
  if (typeof id !== 'string') return res.status(400).json({ error: 'id required' })

  const sb = getServiceClient()

  // Paginate through matches (Supabase row limit is 1000 per query)
  const pageSize = 1000
  let from = 0
  const allRows: any[] = []
  while (true) {
    const { data, error } = await sb
      .from('backfill_matches')
      .select('*')
      .eq('run_id', id)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) return res.status(500).json({ error: error.message })
    if (!data || !data.length) break
    allRows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  const headers = [
    'order_id', 'order_name', 'order_date', 'order_status', 'already_linked',
    'job_number', 'md_rep', 'md_email_norm',
    'match_status',
    'matched_quote_id', 'matched_quote_name', 'matched_quote_board_id',
    'matched_quote_date', 'matched_quote_status',
    'days_before_order', 'alternatives_count',
    'execute_status', 'execute_error', 'executed_at',
  ]

  const lines: string[] = [headers.join(',')]
  for (const r of allRows) {
    lines.push(headers.map(h => csvEscape(r[h])).join(','))
  }

  const csv = lines.join('\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="backfill-plan-${id.slice(0,8)}.csv"`)
  res.status(200).send(csv)
}

export default withAuth('admin:settings', handler)

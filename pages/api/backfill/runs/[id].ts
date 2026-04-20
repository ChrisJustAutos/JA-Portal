// pages/api/backfill/runs/[id].ts
// GET /api/backfill/runs/[id]?status=matched&limit=100&offset=0
// Returns the run row + a paginated slice of match rows.
// Admin only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function handler(req: NextApiRequest, res: NextApiResponse, _user: any) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  const { id } = req.query
  if (typeof id !== 'string') return res.status(400).json({ error: 'id required' })

  const status = (req.query.status as string) || ''
  const search = (req.query.search as string) || ''
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const offset = Math.max(Number(req.query.offset) || 0, 0)

  const sb = getServiceClient()

  const { data: run, error: runErr } = await sb
    .from('backfill_runs')
    .select('*')
    .eq('id', id)
    .single()
  if (runErr || !run) return res.status(404).json({ error: 'Run not found' })

  let q = sb
    .from('backfill_matches')
    .select('*', { count: 'exact' })
    .eq('run_id', id)
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1)

  if (status) q = q.eq('match_status', status)
  if (search) {
    // Search by order name OR job# OR email (ilike, % wildcards)
    const pattern = `%${search.replace(/%/g, '')}%`
    q = q.or(`order_name.ilike.${pattern},job_number.ilike.${pattern},md_email_norm.ilike.${pattern}`)
  }

  const { data: matches, error: mErr, count } = await q
  if (mErr) return res.status(500).json({ error: mErr.message })

  return res.status(200).json({
    run,
    matches: matches || [],
    totalCount: count ?? 0,
    limit,
    offset,
  })
}

export default withAuth('admin:settings', handler)

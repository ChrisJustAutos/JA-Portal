// pages/api/workshop/oncar/index.ts
// GET → the newest "parts on cars" snapshot for the Stocktake (MD) screen.
//
// Serves items/jobs from the newest DONE run so a refresh in flight never
// blanks the screen, while reporting the newest run's state separately so the
// page can show a spinner and an error. Same split as the Pre Pick GET.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export default withAuth('view:stocktakes', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: newest } = await db.from('md_oncar_runs')
    .select('*').order('created_at', { ascending: false }).limit(1).maybeSingle()

  const { data: done } = await db.from('md_oncar_runs')
    .select('*').eq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle()

  if (!done) {
    return res.status(200).json({
      run: null,
      in_flight: !!newest && (newest.status === 'pending' || newest.status === 'running'),
      status: newest?.status || null,
      error: newest?.error || null,
      items: [], jobs: [], job_items: [],
    })
  }

  const [{ data: items }, { data: jobs }, { data: jobItems }] = await Promise.all([
    db.from('md_oncar_items').select('*').eq('run_id', done.id).order('on_cars', { ascending: false }),
    db.from('md_oncar_jobs').select('*').eq('run_id', done.id).order('days_open', { ascending: false }),
    db.from('md_oncar_job_items').select('*').eq('run_id', done.id),
  ])

  return res.status(200).json({
    run: done,
    in_flight: !!newest && (newest.status === 'pending' || newest.status === 'running'),
    status: newest?.status || null,
    error: newest?.status === 'error' ? newest.error : null,
    items: items || [],
    jobs: jobs || [],
    job_items: jobItems || [],
  })
})

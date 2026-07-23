// pages/api/workshop/tune-jobs-md.ts
// Service-token endpoint for the tune-jobs → MechanicDesk worker
// (scripts/import-tune-jobs.ts, GH Actions). Same auth model as the other
// MD workers (X-Service-Token, scope 'stocktake:write').
//
// GET  → { jobs } — submitted tune jobs not yet created in MD (customer +
//        vehicle + job details for the worker to key in).
// POST { outcomes: [{ job_id, md_customer_id?, error? }] } — record results;
//        successful jobs move to status 'synced'.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { validateServiceToken } from '../../../lib/service-auth'
import { markTuneJobMdSynced } from '../../../lib/b2b-tune-jobs'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const svc = await validateServiceToken(req, 'stocktake:write')
  if (!svc) return res.status(401).json({ error: 'Invalid or missing X-Service-Token' })
  const c = sb()

  if (req.method === 'GET') {
    const { data, error } = await c.from('b2b_tune_jobs')
      .select(`
        id, vin, tune_details, invoice_number, amount,
        customer_name, customer_first_name, customer_phone, customer_email,
        customer_address_line1, customer_suburb, customer_state, customer_postcode,
        vehicle_rego, vehicle_description, job_notes,
        distributor:b2b_distributors!b2b_tune_jobs_distributor_id_fkey(display_name)
      `)
      .eq('status', 'submitted')
      .is('md_synced_at', null)
      .order('filled_at', { ascending: true })
      .limit(50)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({
      jobs: (data || []).map((j: any) => ({
        ...j,
        distributor_name: (Array.isArray(j.distributor) ? j.distributor[0] : j.distributor)?.display_name || null,
        distributor: undefined,
      })),
    })
  }

  if (req.method === 'POST') {
    const outcomes = Array.isArray(req.body?.outcomes) ? req.body.outcomes : []
    if (!outcomes.length) return res.status(400).json({ error: 'outcomes required' })
    for (const o of outcomes.slice(0, 100)) {
      if (!o?.job_id) continue
      await markTuneJobMdSynced(String(o.job_id), o.md_customer_id ? String(o.md_customer_id) : null, o.error ? String(o.error) : null)
    }
    return res.status(200).json({ ok: true, recorded: outcomes.length })
  }

  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
}

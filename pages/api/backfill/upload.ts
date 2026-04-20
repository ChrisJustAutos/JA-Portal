// pages/api/backfill/upload.ts
// POST: accept a base64-encoded MD export file, parse it, create a new backfill_run
// and insert the parsed rows into backfill_jobs.
//
// Request body: { filename: string, contentBase64: string }
// Response: { runId: string, rowCount: number, warnings: string[] }
//
// Admin only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { parseMdExport } from '../../../lib/backfill/parseMdExport'

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '15mb',  // MD exports can be a few MB
    },
  },
  maxDuration: 60,
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { filename, contentBase64 } = req.body || {}
  if (!filename || !contentBase64) {
    return res.status(400).json({ error: 'filename and contentBase64 are required' })
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(contentBase64, 'base64')
  } catch {
    return res.status(400).json({ error: 'contentBase64 is not valid base64' })
  }

  let parsed
  try {
    parsed = parseMdExport(buffer, filename)
  } catch (e: any) {
    return res.status(400).json({ error: e.message || 'Parse failed' })
  }

  const sb = getServiceClient()
  // Create run
  const { data: run, error: runErr } = await sb
    .from('backfill_runs')
    .insert({
      created_by: user.id,
      status: 'draft',
      md_filename: filename,
      md_row_count: parsed.rows.length,
    })
    .select('id')
    .single()
  if (runErr || !run) {
    return res.status(500).json({ error: `Could not create run: ${runErr?.message}` })
  }

  // Insert jobs (batched — Postgres can handle a few thousand at once but be safe)
  const batchSize = 500
  for (let i = 0; i < parsed.rows.length; i += batchSize) {
    const batch = parsed.rows.slice(i, i + batchSize).map(r => ({
      run_id: run.id,
      job_number: r.job_number,
      customer_name: null,  // kept null for privacy; not needed for matching
      customer_email_norm: r.customer_email_norm,
      customer_phone_norm: r.customer_phone_norm,
      created_by: r.created_by,
      created_date: r.created_date,
      pickup_time: null,
      status: null,
    }))
    const { error: batchErr } = await sb.from('backfill_jobs').insert(batch)
    if (batchErr) {
      // Roll back the run
      await sb.from('backfill_runs').delete().eq('id', run.id)
      return res.status(500).json({ error: `Job insert failed: ${batchErr.message}` })
    }
  }

  return res.status(200).json({
    runId: run.id,
    rowCount: parsed.rows.length,
    warnings: parsed.warnings,
  })
}

export default withAuth('admin:settings', handler)

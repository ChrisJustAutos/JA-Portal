// pages/api/calls/[id]/analyse.ts
// Enqueues a Claude analysis job for a single call. Returns the job status.
// The FreePBX worker picks up pending jobs every 3 minutes.
// Analyses are also auto-enqueued by transcribe.js when a transcript completes,
// so this endpoint is mostly for manual re-runs after rubric changes.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../../lib/auth'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async (userId?: string) => {
    try {
      if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' })
      }

      const { id } = req.query
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ error: 'Missing call id' })
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })

      const sb = createClient(url, key, { auth: { persistSession: false } })

      // Look up the call
      const { data: call, error: callError } = await sb
        .from('calls')
        .select('id, billsec_seconds, duration_seconds')
        .eq('id', id)
        .maybeSingle()
      if (callError) throw callError
      if (!call) return res.status(404).json({ error: 'Call not found' })

      const durationForAnalysis = call.billsec_seconds || call.duration_seconds || 0
      if (durationForAnalysis < 60) {
        return res.status(400).json({
          error: 'Call too short',
          message: `Analysis requires a call of at least 60 seconds (this call is ${durationForAnalysis}s).`,
        })
      }

      // Check for existing transcript (required for analysis)
      const { data: existingTranscript } = await sb
        .from('call_transcripts')
        .select('id')
        .eq('call_id', id)
        .maybeSingle()

      if (!existingTranscript) {
        return res.status(400).json({
          error: 'No transcript',
          message: 'This call must be transcribed before analysis can run.',
        })
      }

      // Check for existing analysis
      const { data: existingAnalysis } = await sb
        .from('call_analysis')
        .select('id, analysed_at')
        .eq('call_id', id)
        .order('analysed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Check for existing job
      const { data: existingJobs } = await sb
        .from('analysis_jobs')
        .select('id, status, created_at, error_message')
        .eq('call_id', id)
        .order('created_at', { ascending: false })
        .limit(1)

      const latestJob = existingJobs?.[0]

      // GET: return current status without modifying anything
      if (req.method === 'GET') {
        return res.status(200).json({
          hasAnalysis: !!existingAnalysis,
          analysedAt: existingAnalysis?.analysed_at || null,
          job: latestJob || null,
        })
      }

      // POST: enqueue (or return status if already queued)
      // Note: unlike transcription, we allow re-running analysis even if one exists,
      // because rubric updates or manual re-runs are a legitimate use case.
      if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'processing')) {
        return res.status(200).json({
          status: 'already_queued',
          message: `Job is ${latestJob.status}. Worker processes jobs every ~3 minutes.`,
          job: latestJob,
        })
      }

      // Create a new job
      const { data: newJob, error: jobError } = await sb
        .from('analysis_jobs')
        .insert({
          call_id: id,
          status: 'pending',
          requested_by: userId || null,
          requested_reason: existingAnalysis ? 'manual re-analysis' : 'manual',
        })
        .select()
        .single()

      if (jobError) throw jobError

      return res.status(202).json({
        status: 'queued',
        message: 'Analysis queued. Worker processes jobs every ~3 minutes.',
        job: newJob,
      })
    } catch (e: any) {
      console.error('analyse error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

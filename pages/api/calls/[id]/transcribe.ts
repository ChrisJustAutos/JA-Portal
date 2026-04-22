// pages/api/calls/[id]/transcribe.ts
// Enqueues a transcription job for a single call. Returns the job status.
// The FreePBX worker picks up pending jobs every 2 minutes.

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
        .select('id, has_recording, recording_url, billsec_seconds')
        .eq('id', id)
        .maybeSingle()
      if (callError) throw callError
      if (!call) return res.status(404).json({ error: 'Call not found' })

      if (!call.has_recording) {
        return res.status(400).json({ error: 'Call has no recording' })
      }

      // Check for existing transcript
      const { data: existingTranscript } = await sb
        .from('call_transcripts')
        .select('id, transcribed_at')
        .eq('call_id', id)
        .maybeSingle()

      // Check for existing job
      const { data: existingJobs } = await sb
        .from('transcription_jobs')
        .select('id, status, created_at, error_message')
        .eq('call_id', id)
        .order('created_at', { ascending: false })
        .limit(1)

      const latestJob = existingJobs?.[0]

      // GET: return current status without modifying anything
      if (req.method === 'GET') {
        return res.status(200).json({
          hasTranscript: !!existingTranscript,
          transcribedAt: existingTranscript?.transcribed_at || null,
          job: latestJob || null,
        })
      }

      // POST: enqueue (or return status if already queued/done)
      if (existingTranscript) {
        return res.status(200).json({
          status: 'already_done',
          message: 'This call is already transcribed.',
          transcribedAt: existingTranscript.transcribed_at,
        })
      }

      if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'processing')) {
        return res.status(200).json({
          status: 'already_queued',
          message: `Job is ${latestJob.status}. Worker processes jobs every ~2 minutes.`,
          job: latestJob,
        })
      }

      // Create a new job
      const { data: newJob, error: jobError } = await sb
        .from('transcription_jobs')
        .insert({
          call_id: id,
          status: 'pending',
          requested_by: userId || null,
          requested_reason: 'manual',
        })
        .select()
        .single()

      if (jobError) throw jobError

      return res.status(202).json({
        status: 'queued',
        message: 'Transcription queued. Worker processes jobs every ~2 minutes.',
        job: newJob,
      })
    } catch (e: any) {
      console.error('transcribe error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

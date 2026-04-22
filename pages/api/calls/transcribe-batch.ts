// pages/api/calls/transcribe-batch.ts
// Enqueues transcription jobs for many calls matching filter criteria.
// Used by the "Transcribe these N calls" button on the portal.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../lib/auth'

export const config = { maxDuration: 30 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async (userId?: string) => {
    try {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
      }

      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })

      const sb = createClient(url, key, { auth: { persistSession: false } })

      // Parse the same filter params as /api/calls so the batch follows whatever
      // the user's currently looking at.
      const q = req.body || {}
      const startDate = q.startDate ? String(q.startDate) : null
      const endDate = q.endDate ? String(q.endDate) : null
      const extension = q.extension ? String(q.extension) : null
      const direction = q.direction ? String(q.direction) : null
      const disposition = q.disposition ? String(q.disposition) : null
      const maxJobs = Math.min(parseInt(String(q.maxJobs || '50'), 10) || 50, 500)

      // Build the query — find calls WITH recordings that DON'T already have transcripts
      // We can't LEFT JOIN from client — do it as two queries.
      let query = sb.from('calls')
        .select('id, call_date, direction, disposition, agent_ext, has_recording')
        .eq('has_recording', true)
        .not('recording_url', 'is', null)
        .neq('recording_url', 'MISSING')
        .order('call_date', { ascending: false })
        .limit(maxJobs * 2)  // overfetch because some may already have transcripts

      if (startDate) {
        const tzOffsetMs = 10 * 3600 * 1000
        const d = new Date(startDate + 'T00:00:00Z')
        query = query.gte('call_date', new Date(d.getTime() - tzOffsetMs).toISOString())
      }
      if (endDate) {
        const tzOffsetMs = 10 * 3600 * 1000
        const d = new Date(endDate + 'T23:59:59.999Z')
        query = query.lte('call_date', new Date(d.getTime() - tzOffsetMs).toISOString())
      }
      if (extension) query = query.eq('agent_ext', extension)
      if (direction === 'inbound' || direction === 'outbound') query = query.eq('direction', direction)
      if (disposition === 'answered') query = query.eq('disposition', 'ANSWERED')
      else if (disposition === 'missed') query = query.neq('disposition', 'ANSWERED')

      const { data: eligibleCalls, error: callsError } = await query
      if (callsError) throw callsError
      if (!eligibleCalls || eligibleCalls.length === 0) {
        return res.status(200).json({ enqueued: 0, skipped: 0, message: 'No eligible calls match the filters.' })
      }

      // Find which of these already have transcripts
      const callIds = eligibleCalls.map(c => c.id)
      const { data: existingTranscripts } = await sb
        .from('call_transcripts')
        .select('call_id')
        .in('call_id', callIds)

      const alreadyTranscribed = new Set((existingTranscripts || []).map(t => t.call_id))

      // Find which have active (pending/processing) jobs
      const { data: activeJobs } = await sb
        .from('transcription_jobs')
        .select('call_id')
        .in('call_id', callIds)
        .in('status', ['pending', 'processing'])

      const alreadyQueued = new Set((activeJobs || []).map(j => j.call_id))

      // Filter down to calls that need a new job
      const toEnqueue = eligibleCalls
        .filter(c => !alreadyTranscribed.has(c.id) && !alreadyQueued.has(c.id))
        .slice(0, maxJobs)

      if (toEnqueue.length === 0) {
        return res.status(200).json({
          enqueued: 0,
          skipped: eligibleCalls.length,
          message: 'All matching calls are already transcribed or queued.',
        })
      }

      // Batch insert
      const rows = toEnqueue.map(c => ({
        call_id: c.id,
        status: 'pending',
        requested_by: userId || null,
        requested_reason: 'batch',
      }))

      const { error: insertError } = await sb
        .from('transcription_jobs')
        .insert(rows)

      if (insertError) throw insertError

      return res.status(202).json({
        enqueued: toEnqueue.length,
        skipped: eligibleCalls.length - toEnqueue.length,
        message: `Queued ${toEnqueue.length} calls for transcription. Worker processes ~10 jobs every 2 minutes.`,
      })
    } catch (e: any) {
      console.error('transcribe-batch error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

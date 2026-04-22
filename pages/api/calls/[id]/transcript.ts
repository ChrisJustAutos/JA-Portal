// pages/api/calls/[id]/transcript.ts
// Returns the transcript for a call, or 404 if not yet transcribed.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../../lib/auth'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    try {
      if (req.method !== 'GET') {
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

      const { data, error } = await sb
        .from('call_transcripts')
        .select('id, full_text, segments, provider, model, language, audio_duration_seconds, transcribed_at')
        .eq('call_id', id)
        .maybeSingle()

      if (error) throw error
      if (!data) return res.status(404).json({ error: 'No transcript for this call' })

      return res.status(200).json({ transcript: data })
    } catch (e: any) {
      console.error('transcript error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

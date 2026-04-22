// pages/api/calls/[id]/recording-url.ts
// Returns a short-lived signed URL for the call's recording file in Supabase Storage.
// Gated behind view:calls permission. URL expires after 5 minutes.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { requireAuth } from '../../../../lib/auth'

export const config = { maxDuration: 10 }

const URL_TTL_SECONDS = 300  // 5 minutes

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

      // Look up the call and its stored recording path
      const { data: call, error: callError } = await sb
        .from('calls')
        .select('id, linkedid, recording_url, has_recording, recording_file')
        .eq('id', id)
        .maybeSingle()

      if (callError) throw callError
      if (!call) return res.status(404).json({ error: 'Call not found' })

      if (!call.has_recording) {
        return res.status(404).json({ error: 'No recording for this call', reason: 'no_recording' })
      }

      if (!call.recording_url) {
        // Recording exists on FreePBX disk but hasn't been uploaded yet
        return res.status(202).json({
          error: 'Recording not yet uploaded',
          reason: 'pending_upload',
          message: 'Recording will be available shortly — the sync agent uploads recordings every 5 minutes.',
        })
      }

      if (call.recording_url === 'MISSING') {
        return res.status(404).json({
          error: 'Recording file not found on FreePBX disk',
          reason: 'missing_on_disk',
        })
      }

      // Generate a signed URL for the storage object
      const { data: signed, error: signError } = await sb.storage
        .from('call-recordings')
        .createSignedUrl(call.recording_url, URL_TTL_SECONDS)

      if (signError) throw signError
      if (!signed?.signedUrl) {
        return res.status(500).json({ error: 'Failed to generate signed URL' })
      }

      return res.status(200).json({
        url: signed.signedUrl,
        expires_in: URL_TTL_SECONDS,
        filename: call.recording_file,
      })
    } catch (e: any) {
      console.error('recording-url error:', e?.message, e?.stack)
      return res.status(500).json({ error: 'Internal error', message: e?.message || String(e) })
    }
  })
}

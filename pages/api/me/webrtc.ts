// pages/api/me/webrtc.ts
// GET — returns the calling user's WebRTC softphone credentials, used by the
// in-portal SIP.js client to register against FreePBX. The password is sensitive
// and is ONLY returned to the owner — never to other users (no admin lookup
// here; admins write via PATCH /api/users/[id]).
//
// Response shape:
//   { configured: true,  extension, password, wss_url, sip_domain }
//   { configured: false, reason: 'no_extension' | 'no_wss_url' }
//
// Gated to monitor:calls — only people who can actually listen need this.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 5 }

export default withAuth('monitor:calls', async (req, res, user) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return res.status(500).json({ error: 'Supabase not configured' })
  const sb = createClient(url, key, { auth: { persistSession: false } })

  const wss_url    = (process.env.NEXT_PUBLIC_FREEPBX_WSS_URL || '').trim()
  const sip_domain = (process.env.NEXT_PUBLIC_FREEPBX_SIP_DOMAIN || '').trim()
  if (!wss_url || !sip_domain) {
    return res.status(200).json({ configured: false, reason: 'no_wss_url' })
  }

  const { data, error } = await sb
    .from('user_profiles')
    .select('webrtc_extension, webrtc_password')
    .eq('id', user.id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })

  const ext = ((data as any)?.webrtc_extension || '').trim()
  const pwd = ((data as any)?.webrtc_password  || '').trim()
  if (!ext || !pwd) {
    return res.status(200).json({ configured: false, reason: 'no_extension' })
  }

  return res.status(200).json({ configured: true, extension: ext, password: pwd, wss_url, sip_domain })
})

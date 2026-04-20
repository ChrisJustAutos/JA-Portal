// pages/api/users/[id]/resend-invite.ts
// Admin-only. Sends a password reset email to the user — useful for "user never
// set their password" or "user forgot and wants re-invite".

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, audit } from '../../../../lib/authServer'

async function handler(req: NextApiRequest, res: NextApiResponse, actor: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: target, error: lookupErr } = await sb.from('user_profiles').select('email').eq('id', id).single()
  if (lookupErr || !target) return res.status(404).json({ error: 'User not found' })

  const redirectTo = `${req.headers.origin || 'https://ja-portal.vercel.app'}/reset-password`
  const { error } = await sb.auth.resetPasswordForEmail(target.email, { redirectTo })
  if (error) return res.status(500).json({ error: error.message })

  audit(actor, 'resend_invite', { target_user_id: id, target_email: target.email })
  return res.status(200).json({ success: true, emailSent: true })
}

export default withAuth('admin:users', handler)

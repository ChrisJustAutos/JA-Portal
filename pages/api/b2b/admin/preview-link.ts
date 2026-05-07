// pages/api/b2b/admin/preview-link.ts
//
// POST /api/b2b/admin/preview-link
//
// Body: { distributor_id: <uuid> }
//
// Returns: { link: <one-time magic-link URL>, signed_in_as: { email, full_name } }
//
// Mints a magic link via Supabase admin generateLink() for an active
// b2b_distributor_user attached to the given distributor. The frontend
// opens that URL in a new tab; clicking it puts the admin in the b2b
// session as that user — without sending email.
//
// Use case: admin wants to verify what the distributor catalogue, cart,
// or orders look like without going through the magic-link email loop on
// a test distributor.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

function siteOrigin(req: NextApiRequest): string {
  // Use the public env var when set, fall back to the request host. Keeps
  // local dev (localhost:3000) and production both working.
  const env = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')
  if (env) return env
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${host}`
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'POST only' })
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const distributor_id = String(body.distributor_id || '').trim()
  if (!distributor_id) return res.status(400).json({ error: 'distributor_id required' })

  const c = sb()

  // Confirm distributor exists + is active
  const { data: dist, error: dErr } = await c
    .from('b2b_distributors')
    .select('id, display_name, is_active')
    .eq('id', distributor_id)
    .maybeSingle()
  if (dErr)        return res.status(500).json({ error: dErr.message })
  if (!dist)       return res.status(404).json({ error: 'Distributor not found' })
  if (!dist.is_active) return res.status(400).json({ error: 'Distributor is inactive' })

  // Pick an active b2b user for that distributor — prefer 'owner', otherwise oldest member.
  const { data: users, error: uErr } = await c
    .from('b2b_distributor_users')
    .select('id, email, full_name, role, is_active, created_at')
    .eq('distributor_id', distributor_id)
    .eq('is_active', true)
    .order('role', { ascending: true })  // owner < member alphabetically
    .order('created_at', { ascending: true })
  if (uErr) return res.status(500).json({ error: uErr.message })
  const target = (users || []).find(u => u.role === 'owner') || (users || [])[0]
  if (!target) {
    return res.status(400).json({
      error: `No active users on "${dist.display_name}". Add a distributor user before previewing.`,
    })
  }

  // Mint the magic link
  const redirectTo = `${siteOrigin(req)}/b2b/auth/callback`
  const { data: linkData, error: lErr } = await c.auth.admin.generateLink({
    type: 'magiclink',
    email: target.email,
    options: { redirectTo },
  })
  if (lErr) {
    console.error('generateLink failed:', lErr)
    return res.status(500).json({ error: lErr.message || 'Could not generate preview link' })
  }
  const link = (linkData as any)?.properties?.action_link
  if (!link) return res.status(500).json({ error: 'Supabase returned no action_link' })

  return res.status(200).json({
    link,
    signed_in_as: {
      email: target.email,
      full_name: target.full_name,
      distributor: dist.display_name,
    },
  })
})

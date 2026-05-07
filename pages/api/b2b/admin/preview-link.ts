// pages/api/b2b/admin/preview-link.ts
//
// POST /api/b2b/admin/preview-link
//
// Body: { distributor_id: <uuid> } OR { tier_id: <uuid> }
//
// Returns: { link: <one-time magic-link URL>, signed_in_as: { email, full_name, distributor, tier? } }
//
// Mints a magic link via Supabase admin generateLink() for an active
// b2b_distributor_user. The frontend opens that URL in a new tab;
// clicking it puts the admin in the b2b session as that user — without
// sending email.
//
// When { tier_id } is supplied, picks any active distributor in that
// tier (preferring one with the most users) and previews as them. Used
// by the catalogue toolbar's "Preview as tier" dropdown.
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
  const distributorId = body.distributor_id ? String(body.distributor_id).trim() : ''
  const tierId        = body.tier_id        ? String(body.tier_id).trim() : ''
  if (!distributorId && !tierId) {
    return res.status(400).json({ error: 'distributor_id or tier_id required' })
  }

  const c = sb()

  // Resolve to a single distributor: either explicit (distributor_id) or
  // pick a representative active one in the requested tier.
  let dist: { id: string; display_name: string; is_active: boolean } | null = null
  let tierName: string | null = null

  if (distributorId) {
    const { data, error: dErr } = await c
      .from('b2b_distributors')
      .select('id, display_name, is_active')
      .eq('id', distributorId)
      .maybeSingle()
    if (dErr) return res.status(500).json({ error: dErr.message })
    if (!data) return res.status(404).json({ error: 'Distributor not found' })
    if (!data.is_active) return res.status(400).json({ error: 'Distributor is inactive' })
    dist = data
  } else {
    const { data: tier, error: tErr } = await c
      .from('b2b_tiers')
      .select('id, name, is_active')
      .eq('id', tierId)
      .maybeSingle()
    if (tErr)  return res.status(500).json({ error: tErr.message })
    if (!tier) return res.status(404).json({ error: 'Tier not found' })
    tierName = tier.name
    // Find any active distributor in that tier. Prefer ones with active users.
    const { data: candidates, error: cErr } = await c
      .from('b2b_distributors')
      .select('id, display_name, is_active')
      .eq('tier_id', tierId)
      .eq('is_active', true)
      .order('display_name', { ascending: true })
    if (cErr) return res.status(500).json({ error: cErr.message })
    if (!candidates || candidates.length === 0) {
      return res.status(400).json({ error: `No active distributors are assigned to "${tier.name}". Assign one first.` })
    }
    // Walk candidates and pick the first that has an active user (so the
    // magic-link mint can find an inbox to anchor to).
    for (const cand of candidates) {
      const { count } = await c
        .from('b2b_distributor_users')
        .select('id', { count: 'exact', head: true })
        .eq('distributor_id', cand.id)
        .eq('is_active', true)
      if ((count || 0) > 0) { dist = cand; break }
    }
    if (!dist) {
      return res.status(400).json({
        error: `No distributor in "${tier.name}" has an active user. Add one before previewing as this tier.`,
      })
    }
  }

  // Pick an active b2b user for that distributor — prefer 'owner', otherwise oldest member.
  const { data: users, error: uErr } = await c
    .from('b2b_distributor_users')
    .select('id, email, full_name, role, is_active, created_at')
    .eq('distributor_id', dist.id)
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
      tier: tierName,
    },
  })
})

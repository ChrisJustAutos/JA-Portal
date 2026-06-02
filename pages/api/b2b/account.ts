// pages/api/b2b/account.ts
// Distributor-facing account details for the Settings screen. Read-only — shows
// the company, delivery/billing addresses, contact emails, and the signed-in
// user's profile. Changes are made by the account manager (admin side).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../lib/b2bAuthServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  const c = sb()
  const { data: d, error } = await c
    .from('b2b_distributors')
    .select(`
      display_name, trading_name, abn,
      primary_contact_email, primary_contact_phone,
      ship_line1, ship_line2, ship_suburb, ship_state, ship_postcode, ship_country,
      bill_line1, bill_line2, bill_suburb, bill_state, bill_postcode, bill_country,
      freight_email, invoice_email, instructions_email
    `)
    .eq('id', user.distributor.id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })

  // Active team member count (for a quick "X users" stat).
  const { count: teamCount } = await c
    .from('b2b_distributor_users')
    .select('id', { count: 'exact', head: true })
    .eq('distributor_id', user.distributor.id)
    .eq('is_active', true)

  return res.status(200).json({
    distributor: d || {},
    teamCount: teamCount ?? null,
    profile: {
      full_name: user.fullName,
      email: user.email,
      role: user.role,
    },
  })
})

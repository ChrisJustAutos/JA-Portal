// pages/api/b2b/admin/distributors/index.ts
//
// GET    /api/b2b/admin/distributors           — list all distributors
// POST   /api/b2b/admin/distributors           — create a new distributor
//
// Permission: edit:b2b_distributors

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  if (req.method === 'GET') return handleList(res)
  if (req.method === 'POST') return handleCreate(req, res, user)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'GET or POST only' })
})

async function handleList(res: NextApiResponse) {
  const c = sb()
  const { data, error } = await c
    .from('b2b_distributors')
    .select(`
      id,
      display_name,
      abn,
      myob_primary_customer_uid,
      myob_primary_customer_display_id,
      myob_linked_customer_uids,
      dist_group_id,
      primary_contact_email,
      primary_contact_phone,
      account_terms_days,
      credit_limit_ex_gst,
      payment_methods,
      is_active,
      notes,
      created_at,
      updated_at
    `)
    .order('display_name', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })

  // Tack on user counts in a single follow-up query
  const ids = (data || []).map((d: any) => d.id)
  let userCounts: Record<string, number> = {}
  if (ids.length > 0) {
    const { data: users, error: uErr } = await c
      .from('b2b_distributor_users')
      .select('distributor_id, is_active')
      .in('distributor_id', ids)
    if (!uErr && users) {
      for (const u of users) {
        if (u.is_active) {
          userCounts[u.distributor_id] = (userCounts[u.distributor_id] || 0) + 1
        }
      }
    }
  }

  const items = (data || []).map((d: any) => ({
    ...d,
    active_user_count: userCounts[d.id] || 0,
  }))

  return res.status(200).json({ items })
}

async function handleCreate(req: NextApiRequest, res: NextApiResponse, user: PortalUser) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}

  const display_name                     = String(body.display_name || '').trim()
  const myob_primary_customer_uid        = String(body.myob_primary_customer_uid || '').trim()
  const myob_primary_customer_display_id = body.myob_primary_customer_display_id ? String(body.myob_primary_customer_display_id).trim() : null
  const abn                              = body.abn ? String(body.abn).trim() : null
  const primary_contact_email            = body.primary_contact_email ? String(body.primary_contact_email).trim().toLowerCase() : null
  const primary_contact_phone            = body.primary_contact_phone ? String(body.primary_contact_phone).trim() : null
  const dist_group_id                    = body.dist_group_id ? String(body.dist_group_id).trim() : null
  const myob_linked_customer_uids        = Array.isArray(body.myob_linked_customer_uids)
    ? body.myob_linked_customer_uids.filter((x: any) => typeof x === 'string' && x.length > 0)
    : []
  const notes                            = body.notes ? String(body.notes) : null

  if (!display_name) return res.status(400).json({ error: 'display_name required' })
  if (!myob_primary_customer_uid) return res.status(400).json({ error: 'myob_primary_customer_uid required' })

  const c = sb()

  // Check for duplicate primary_customer_uid (one distributor per MYOB card)
  const { data: dup } = await c
    .from('b2b_distributors')
    .select('id, display_name')
    .eq('myob_primary_customer_uid', myob_primary_customer_uid)
    .maybeSingle()
  if (dup) {
    return res.status(409).json({
      error: `MYOB customer is already linked to distributor "${dup.display_name}".`,
      existing_id: dup.id,
    })
  }

  const { data, error } = await c
    .from('b2b_distributors')
    .insert({
      display_name,
      abn,
      myob_primary_customer_uid,
      myob_primary_customer_display_id,
      myob_linked_customer_uids,
      dist_group_id,
      primary_contact_email,
      primary_contact_phone,
      notes,
      is_active: true,
      created_by: user.id,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ item: data })
}

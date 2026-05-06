// pages/api/b2b/admin/distributors/[id]/index.ts
//
// GET    /api/b2b/admin/distributors/{id}  — full detail, includes users[]
// PATCH  /api/b2b/admin/distributors/{id}  — update editable fields
//
// Permission: edit:b2b_distributors

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

const EDITABLE = [
  'display_name',
  'abn',
  'myob_primary_customer_uid',
  'myob_primary_customer_display_id',
  'myob_linked_customer_uids',
  'dist_group_id',
  'primary_contact_email',
  'primary_contact_phone',
  'account_terms_days',
  'credit_limit_ex_gst',
  'payment_methods',
  'is_active',
  'notes',
] as const

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, _user: PortalUser) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'Missing id' })

  if (req.method === 'GET') return handleGet(id, res)
  if (req.method === 'PATCH') return handlePatch(id, req, res)
  res.setHeader('Allow', 'GET, PATCH')
  return res.status(405).json({ error: 'GET or PATCH only' })
})

async function handleGet(id: string, res: NextApiResponse) {
  const c = sb()
  const { data, error } = await c
    .from('b2b_distributors')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Distributor not found' })

  const { data: users } = await c
    .from('b2b_distributor_users')
    .select('id, auth_user_id, email, full_name, role, last_login_at, invited_at, invited_by, is_active, created_at')
    .eq('distributor_id', id)
    .order('created_at', { ascending: true })

  // Load dist group name if linked
  let dist_group_name: string | null = null
  if (data.dist_group_id) {
    const { data: dg } = await c
      .from('dist_groups')
      .select('name')
      .eq('id', data.dist_group_id)
      .maybeSingle()
    dist_group_name = dg?.name || null
  }

  return res.status(200).json({
    item: data,
    users: users || [],
    dist_group_name,
  })
}

async function handlePatch(id: string, req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const update: Record<string, any> = {}
  for (const key of EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      update[key] = body[key]
    }
  }
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No editable fields supplied' })
  }

  // Light validation
  if ('display_name' in update) {
    const v = String(update.display_name || '').trim()
    if (!v) return res.status(400).json({ error: 'display_name cannot be empty' })
    update.display_name = v
  }
  if ('myob_primary_customer_uid' in update) {
    const v = String(update.myob_primary_customer_uid || '').trim()
    if (!v) return res.status(400).json({ error: 'myob_primary_customer_uid cannot be empty' })
    update.myob_primary_customer_uid = v
  }
  if ('primary_contact_email' in update && update.primary_contact_email != null) {
    update.primary_contact_email = String(update.primary_contact_email).trim().toLowerCase() || null
  }
  if ('myob_linked_customer_uids' in update) {
    if (!Array.isArray(update.myob_linked_customer_uids)) {
      return res.status(400).json({ error: 'myob_linked_customer_uids must be array' })
    }
    update.myob_linked_customer_uids = update.myob_linked_customer_uids
      .filter((x: any) => typeof x === 'string' && x.length > 0)
  }
  if ('payment_methods' in update) {
    if (!Array.isArray(update.payment_methods)) {
      return res.status(400).json({ error: 'payment_methods must be array' })
    }
  }
  if ('is_active' in update && typeof update.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' })
  }

  const c = sb()
  const { data, error } = await c
    .from('b2b_distributors')
    .update(update)
    .eq('id', id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Distributor not found' })

  return res.status(200).json({ item: data })
}

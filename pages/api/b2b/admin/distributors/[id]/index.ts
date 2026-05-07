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
  'is_active',
  'notes',
  'tier_id',
  // Shipping address
  'ship_line1', 'ship_line2', 'ship_suburb', 'ship_state', 'ship_postcode', 'ship_country',
  // Billing address
  'bill_line1', 'bill_line2', 'bill_suburb', 'bill_state', 'bill_postcode', 'bill_country',
  // Outbound notification emails (separate from the login email on
  // primary_contact_email — these are purely "send mail to here" addresses)
  'freight_email', 'invoice_email', 'instructions_email',
] as const

const NOTIFICATION_EMAIL_FIELDS = [
  'freight_email', 'invoice_email', 'instructions_email',
] as const

const ADDRESS_FIELDS = [
  'ship_line1', 'ship_line2', 'ship_suburb', 'ship_state', 'ship_postcode', 'ship_country',
  'bill_line1', 'bill_line2', 'bill_suburb', 'bill_state', 'bill_postcode', 'bill_country',
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

  // Load tier name if linked
  let tier_name: string | null = null
  if (data.tier_id) {
    const { data: tier } = await c
      .from('b2b_tiers')
      .select('name')
      .eq('id', data.tier_id)
      .maybeSingle()
    tier_name = tier?.name || null
  }

  // Load all active tiers so the dropdown can render even when this
  // distributor has no tier assigned yet.
  const { data: tiers } = await c
    .from('b2b_tiers')
    .select('id, name, is_active')
    .order('display_order', { ascending: true })
    .order('name',          { ascending: true })

  return res.status(200).json({
    item: data,
    users: users || [],
    dist_group_name,
    tier_name,
    tiers: tiers || [],
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
  for (const k of NOTIFICATION_EMAIL_FIELDS) {
    if (k in update) {
      if (update[k] === null) continue
      if (typeof update[k] !== 'string') {
        return res.status(400).json({ error: `${k} must be string or null` })
      }
      const v = update[k].trim().toLowerCase()
      update[k] = v === '' ? null : v
    }
  }
  if ('myob_linked_customer_uids' in update) {
    if (!Array.isArray(update.myob_linked_customer_uids)) {
      return res.status(400).json({ error: 'myob_linked_customer_uids must be array' })
    }
    update.myob_linked_customer_uids = update.myob_linked_customer_uids
      .filter((x: any) => typeof x === 'string' && x.length > 0)
  }
  if ('is_active' in update && typeof update.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active must be boolean' })
  }
  if ('tier_id' in update && update.tier_id !== null && typeof update.tier_id !== 'string') {
    return res.status(400).json({ error: 'tier_id must be uuid string or null' })
  }
  if ('tier_id' in update && typeof update.tier_id === 'string' && update.tier_id === '') {
    update.tier_id = null
  }
  // Address fields: trim, coerce empty string to null. Country uppercased.
  for (const k of ADDRESS_FIELDS) {
    if (k in update) {
      if (update[k] === null) continue
      if (typeof update[k] !== 'string') {
        return res.status(400).json({ error: `${k} must be string or null` })
      }
      const trimmed = update[k].trim()
      update[k] = trimmed === '' ? null : (k.endsWith('_country') ? trimmed.toUpperCase() : trimmed)
    }
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

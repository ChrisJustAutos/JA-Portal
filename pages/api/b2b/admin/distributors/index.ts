// pages/api/b2b/admin/distributors/index.ts
//
// GET    /api/b2b/admin/distributors           — list all distributors
// POST   /api/b2b/admin/distributors           — create a new distributor
//
// Permission: edit:b2b_distributors

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'
import { fetchCardSummaries, displayIdMissing } from '../../../../../lib/b2b-distributor-myob'

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
      tier_id,
      primary_contact_email,
      primary_contact_phone,
      is_active,
      notes,
      created_at,
      updated_at,
      tier:b2b_tiers!b2b_distributors_tier_id_fkey ( id, name )
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

  const items = (data || []).map((d: any) => {
    const tier = Array.isArray(d.tier) ? d.tier[0] : d.tier
    return {
      ...d,
      tier: undefined,
      tier_name: tier?.name || null,
      active_user_count: userCounts[d.id] || 0,
    }
  })

  // Self-heal stale MYOB Card IDs: any row whose stored DisplayID is missing or
  // "*None" gets re-read live from MYOB (the card may have gained a Card ID
  // after the distributor was created). Best-effort — failures leave it as-is.
  const needSync = items.filter((d: any) => d.myob_primary_customer_uid && displayIdMissing(d.myob_primary_customer_display_id))
  if (needSync.length > 0) {
    try {
      const summaries = await fetchCardSummaries(needSync.map((d: any) => d.myob_primary_customer_uid))
      const updates: { id: string; display_id: string }[] = []
      for (const d of needSync) {
        const s = summaries.get(d.myob_primary_customer_uid)
        if (s && s.display_id) { d.myob_primary_customer_display_id = s.display_id; updates.push({ id: d.id, display_id: s.display_id }) }
      }
      // Persist so subsequent loads are instant (no re-fetch).
      await Promise.all(updates.map(u =>
        c.from('b2b_distributors').update({ myob_primary_customer_display_id: u.display_id }).eq('id', u.id),
      ))
    } catch { /* best-effort heal */ }
  }

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

  // Optional ship/bill address (prefilled from the MYOB card on the client).
  const ADDR_FIELDS = [
    'ship_line1', 'ship_line2', 'ship_suburb', 'ship_state', 'ship_postcode', 'ship_country',
    'bill_line1', 'bill_line2', 'bill_suburb', 'bill_state', 'bill_postcode', 'bill_country',
  ] as const
  const address: Record<string, string | null> = {}
  for (const f of ADDR_FIELDS) address[f] = body[f] ? String(body[f]).trim() || null : null

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
      ...address,
      is_active: true,
      created_by: user.id,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ item: data })
}

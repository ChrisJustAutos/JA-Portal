// pages/api/b2b/admin/distributors/[id]/index.ts
//
// GET    /api/b2b/admin/distributors/{id}  — full detail, includes users[]
// PATCH  /api/b2b/admin/distributors/{id}  — update editable fields
//
// Permission: edit:b2b_distributors

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../lib/authServer'
import { resyncDistributorMyob } from '../../../../../../lib/b2b-distributor-myob'

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
  'checkout_enabled',
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
  if (req.method === 'DELETE') return handleDelete(id, res)
  if (req.method === 'POST' && (req.body || {}).action === 'resend_invites') {
    return handleResendInvites(id, res)
  }
  res.setHeader('Allow', 'GET, PATCH, DELETE, POST')
  return res.status(405).json({ error: 'GET, PATCH, DELETE, or POST {action:"resend_invites"} only' })
})

// Re-send fresh invite links to every active user on this distributor who
// has never signed in (used from the distributors list "Resend" button).
async function handleResendInvites(id: string, res: NextApiResponse) {
  const c = sb()
  // The USER-level is_active filter below has always been right. The ACCOUNT
  // level was not checked at all, so an inactive distributor with active users
  // would still be emailed a sign-up link for an account that cannot order.
  // Hiding the button is not enough — this is a POST anyone can repeat.
  const { data: dist } = await c.from('b2b_distributors').select('is_active, display_name').eq('id', id).maybeSingle()
  if (!dist) return res.status(404).json({ error: 'Distributor not found' })
  if (!dist.is_active) {
    return res.status(409).json({ error: `${dist.display_name || 'This distributor'} is inactive — reactivate the account before inviting anyone to it.` })
  }
  const { data: pending, error } = await c
    .from('b2b_distributor_users')
    .select('id, email')
    .eq('distributor_id', id)
    .eq('is_active', true)
    .is('last_login_at', null)
    .not('email', 'like', 'preview+%@justautos.app')
    .not('auth_user_id', 'is', null)
  if (error) return res.status(500).json({ error: error.message })
  if (!pending || pending.length === 0) {
    return res.status(400).json({ error: 'No pending invites on this distributor — everyone has either signed in already or was never invited.' })
  }
  const { resendInviteEmail } = await import('../../../../../../lib/b2b-invites')
  const results: { email: string; ok: boolean; error?: string }[] = []
  for (const p of pending) {
    const r = await resendInviteEmail(c, p.id)
    results.push({ email: p.email, ok: r.ok, error: r.error })
  }
  const sent = results.filter(r => r.ok).map(r => r.email)
  const failed = results.filter(r => !r.ok)
  return res.status(failed.length && !sent.length ? 502 : 200).json({ ok: failed.length === 0, sent, failed })
}

// Everything that REFUSES to let a distributor go, because the records are
// history worth keeping. There are four, and only b2b_orders was being checked
// — so deleting a distributor who had tune jobs but no orders got the raw
// Postgres constraint text thrown at the screen (Chris 2026-09-02:
// 'violates foreign key constraint "b2b_tune_jobs_distributor_id_fkey"').
//
// The other five references cascade on purpose: carts, addresses, shipping
// addresses, logins and training assignments are all things that only exist to
// serve a live distributor.
const DELETE_BLOCKERS: { table: string; label: (n: number) => string }[] = [
  { table: 'b2b_orders',              label: n => `${n} order${n === 1 ? '' : 's'}` },
  { table: 'b2b_tune_jobs',           label: n => `${n} tune job${n === 1 ? '' : 's'}` },
  { table: 'b2b_training_attempts',   label: n => `${n} training attempt${n === 1 ? '' : 's'}` },
  { table: 'b2b_tune_company_aliases',label: n => `${n} tune company alias${n === 1 ? '' : 'es'}` },
]

async function handleDelete(id: string, res: NextApiResponse) {
  const c = sb()

  // Counted in one pass so the message names EVERYTHING holding the delete,
  // rather than making someone clear one blocker and meet the next.
  const found: string[] = []
  for (const b of DELETE_BLOCKERS) {
    const { count, error } = await c.from(b.table)
      .select('id', { count: 'exact', head: true }).eq('distributor_id', id)
    // A failed count must not read as "nothing there" — that is how a delete
    // gets through and takes history with it.
    if (error) return res.status(500).json({ error: `Couldn't check ${b.table} before deleting: ${error.message}` })
    if ((count || 0) > 0) found.push(b.label(count || 0))
  }

  if (found.length) {
    const list = found.length === 1 ? found[0]
      : `${found.slice(0, -1).join(', ')} and ${found[found.length - 1]}`
    return res.status(409).json({
      error: `Can't delete this distributor — they still have ${list}, and deleting them would take that history with it. Switch Active off instead: they keep their records and disappear from the ordering side.`,
    })
  }

  // Cascades remove logins, carts, addresses and training assignments.
  const { error } = await c.from('b2b_distributors').delete().eq('id', id)
  if (error) {
    // A constraint we do not know about yet. Say something useful rather than
    // handing the raw Postgres text to whoever pressed the button.
    const fk = /foreign key constraint "([^"]+)"/.exec(error.message)
    return res.status(409).json({
      error: fk
        ? `Can't delete this distributor — records elsewhere still point at them (${fk[1]}). Switch Active off instead.`
        : `Couldn't delete this distributor: ${error.message}`,
    })
  }
  return res.status(200).json({ ok: true })
}

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

  // Re-sync the MYOB card info live (Card ID may have changed since creation)
  // and resolve linked-card names. Best-effort — never blocks the page.
  let linked_customers: { uid: string; display_id: string; name: string }[] = []
  try {
    const synced = await resyncDistributorMyob(c, data as any)
    if (synced.primary_display_id !== data.myob_primary_customer_display_id) {
      data.myob_primary_customer_display_id = synced.primary_display_id
    }
    linked_customers = synced.linked
  } catch { /* best-effort */ }

  return res.status(200).json({
    item: data,
    users: users || [],
    dist_group_name,
    tier_name,
    tiers: tiers || [],
    linked_customers,
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
  if ('checkout_enabled' in update && typeof update.checkout_enabled !== 'boolean') {
    return res.status(400).json({ error: 'checkout_enabled must be boolean' })
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

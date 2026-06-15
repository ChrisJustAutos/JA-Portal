// pages/api/b2b/admin/suppliers/[id]/users.ts
// POST  — invite a login for this supplier (Supabase invite → set-password →
//         lands on /b2b/supplier). Inserts a b2b_supplier_users row.
// PATCH  { user_id, is_active } — enable/disable a supplier login.
// Permission: edit:b2b_distributors
import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../../lib/authServer'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  const c = sb()
  const supplierId = String(req.query.id || '').trim()
  if (!supplierId) return res.status(400).json({ error: 'Missing supplier id' })

  if (req.method === 'PATCH') {
    const body = (req.body && typeof req.body === 'object') ? req.body : {}
    const userId = String(body.user_id || '').trim()
    if (!userId) return res.status(400).json({ error: 'user_id required' })
    const { error } = await c.from('b2b_supplier_users').update({ is_active: !!body.is_active }).eq('id', userId).eq('supplier_id', supplierId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method !== 'POST') { res.setHeader('Allow', 'POST, PATCH'); return res.status(405).json({ error: 'POST or PATCH only' }) }

  const body = (req.body && typeof req.body === 'object') ? req.body : {}
  const email = String(body.email || '').trim().toLowerCase()
  const full_name = body.full_name ? String(body.full_name).trim() : null
  if (!email) return res.status(400).json({ error: 'email required' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' })

  const { data: supplier } = await c.from('b2b_suppliers').select('id, name').eq('id', supplierId).maybeSingle()
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' })

  // Email must be free across BOTH supplier and distributor logins (one auth
  // user → one B2B identity).
  const [{ data: supDup }, { data: distDup }] = await Promise.all([
    c.from('b2b_supplier_users').select('id, supplier_id').eq('email', email).maybeSingle(),
    c.from('b2b_distributor_users').select('id').eq('email', email).maybeSingle(),
  ])
  if (supDup) return res.status(409).json({ error: supDup.supplier_id === supplierId ? 'This email is already a login on this supplier.' : 'This email is already linked to a different supplier.' })
  if (distDup) return res.status(409).json({ error: 'This email is already a distributor login.' })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'
  const redirectTo = `${baseUrl}/reset-password?welcome=1&next=${encodeURIComponent('/b2b/supplier')}`

  let authUserId: string
  try {
    const { data: authData, error: inviteErr } = await c.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { b2b_supplier_id: supplierId, b2b_supplier_name: supplier.name },
    })
    if (inviteErr) {
      const msg = String(inviteErr.message || '').toLowerCase()
      if (msg.includes('already') || msg.includes('registered') || (inviteErr as any).status === 422) {
        return res.status(409).json({ error: 'This email already has a Supabase account. Contact support to link them manually.', detail: inviteErr.message })
      }
      return res.status(502).json({ error: 'Supabase invite failed', detail: inviteErr.message })
    }
    if (!authData?.user?.id) return res.status(502).json({ error: 'Supabase invite returned no user id' })
    authUserId = authData.user.id
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) })
  }

  const { data: supUser, error: insErr } = await c.from('b2b_supplier_users').insert({
    supplier_id: supplierId, auth_user_id: authUserId, email, full_name,
    invited_at: new Date().toISOString(), invited_by: user.id, is_active: true,
  }).select().single()
  if (insErr) {
    try { await c.auth.admin.deleteUser(authUserId) } catch { /* swallow */ }
    return res.status(500).json({ error: 'Failed to link login to supplier', detail: insErr.message })
  }
  return res.status(201).json({ user: supUser, invite_sent_to: email })
})

// pages/api/b2b/admin/training/assignments.ts
// Create / revoke training assignments (backs the tick-boxes on
// /admin/b2b/training).
//   POST   { module_id, distributor_id, distributor_user_id? } → { assignment }
//   DELETE { module_id, distributor_id, distributor_user_id? } → { ok }
// distributor_user_id omitted/null = the whole-distributor row (every
// current + future membership of that distributor); set = that one
// b2b_distributor_users row. Duplicate creates are idempotent (the partial
// unique indexes from migration 192 are the guard).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth, PortalUser } from '../../../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth('edit:b2b_distributors', async (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => {
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const moduleId = String(b.module_id || '').trim()
  const distributorId = String(b.distributor_id || '').trim()
  const distributorUserId = b.distributor_user_id ? String(b.distributor_user_id).trim() : null
  if (!moduleId || !distributorId) return res.status(400).json({ error: 'module_id and distributor_id required' })

  const c = sb()

  if (req.method === 'POST') {
    if (distributorUserId) {
      // Membership rows are distributor-scoped — refuse a cross-distributor mismatch.
      const { data: memb, error: mErr } = await c.from('b2b_distributor_users')
        .select('id, distributor_id').eq('id', distributorUserId).maybeSingle()
      if (mErr) return res.status(500).json({ error: mErr.message })
      if (!memb || memb.distributor_id !== distributorId) {
        return res.status(400).json({ error: 'distributor_user_id does not belong to that distributor' })
      }
    }
    const { data, error } = await c.from('b2b_training_assignments')
      .insert({
        module_id: moduleId,
        distributor_id: distributorId,
        distributor_user_id: distributorUserId,
        created_by: user.id || null,
      })
      .select('id, module_id, distributor_id, distributor_user_id')
      .single()
    if (error) {
      if (error.code === '23505') return res.status(200).json({ ok: true, duplicate: true })  // already assigned
      return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true, assignment: data })
  }

  if (req.method === 'DELETE') {
    let q = c.from('b2b_training_assignments').delete()
      .eq('module_id', moduleId)
      .eq('distributor_id', distributorId)
    q = distributorUserId ? q.eq('distributor_user_id', distributorUserId) : q.is('distributor_user_id', null)
    const { error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'POST, DELETE')
  return res.status(405).json({ error: 'POST or DELETE only' })
})

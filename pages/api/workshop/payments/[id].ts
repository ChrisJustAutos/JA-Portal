// pages/api/workshop/payments/[id].ts
// DELETE — soft delete (set deleted_at). ?hard=1 + admin → hard delete.
// POST   ?restore=1 — clear deleted_at.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

export const config = { maxDuration: 10 }

export default withAuth('view:diary', async (req, res, user) => {
  if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  if (req.method === 'DELETE') {
    const hard = String(req.query.hard || '') === '1'
    if (hard) {
      if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only for hard delete' })
      const { error } = await db.from('workshop_payments').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, hard: true })
    }
    const { error } = await db.from('workshop_payments').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'POST' && String(req.query.restore || '') === '1') {
    const { error } = await db.from('workshop_payments').update({ deleted_at: null }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'DELETE, POST')
  return res.status(405).json({ error: 'DELETE or POST?restore=1 only' })
})

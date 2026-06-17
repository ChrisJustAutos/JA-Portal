// pages/api/workshop/credit-notes/[id].ts
// GET    — credit note detail (+ lines)
// DELETE — soft-delete. Refused for MYOB-posted credit notes unless admin
//          (the MYOB record can't be deleted from here, only voided in MYOB).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { logWorkshopActivity } from '../../../../lib/workshop-activity'

export const config = { maxDuration: 10 }

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data: cn, error } = await db.from('workshop_credit_notes')
      .select('*, customer:workshop_customers!customer_id(id, name), lines:workshop_credit_note_lines(*)')
      .eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!cn) return res.status(404).json({ error: 'Credit note not found' })
    return res.status(200).json({ creditNote: cn })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    const { data: cn } = await db.from('workshop_credit_notes').select('id, cn_seq, myob_credit_uid, deleted_at').eq('id', id).maybeSingle()
    if (!cn) return res.status(404).json({ error: 'Credit note not found' })
    if (cn.myob_credit_uid && !roleHasPermission(user.role, 'admin:settings')) {
      return res.status(409).json({ error: 'This credit note is already in MYOB — void it there first (or ask an admin to remove the local record).' })
    }
    const { error } = await db.from('workshop_credit_notes').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    // Cancel the linked local refund row so balances re-net.
    await db.from('workshop_payments').update({ deleted_at: new Date().toISOString() }).eq('credit_note_id', id).is('deleted_at', null)
    await logWorkshopActivity(db, {
      action: 'deleted', entity: 'credit_note', entity_id: id, entity_label: `CN-${cn.cn_seq}`,
      actor_id: user.id, actor_name: user.displayName || user.email,
    })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'GET or DELETE only' })
})

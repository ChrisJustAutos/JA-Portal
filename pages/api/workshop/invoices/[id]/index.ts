// pages/api/workshop/invoices/[id]/index.ts
// GET — single invoice + lines + payments.
// DELETE — soft delete (move to trash). ?hard=1 + admin → hard delete.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { roleHasPermission } from '../../../../../lib/permissions'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const [iRes, lRes, pRes] = await Promise.all([
      db.from('workshop_invoices')
        .select(`id, status, subtotal, gst, total, due_date, issue_date, order_number, created_at, deleted_at, booking_id, md_id, myob_invoice_uid,
                 customer:workshop_customers!customer_id(id, name, mobile, phone, email)`)
        .eq('id', id).maybeSingle(),
      db.from('workshop_invoice_lines').select('*').eq('invoice_id', id).order('sort_order', { ascending: true }),
      db.from('workshop_payments').select('id, amount, tender, method, created_at, deleted_at, md_id').eq('invoice_id', id).order('created_at', { ascending: false }),
    ])
    if (iRes.error || !iRes.data) return res.status(404).json({ error: 'Invoice not found' })
    return res.status(200).json({ invoice: iRes.data, lines: lRes.data || [], payments: pRes.data || [] })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    const hard = String(req.query.hard || '') === '1'
    if (hard) {
      if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only for hard delete' })
      const { error } = await db.from('workshop_invoices').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, hard: true })
    }
    const { error } = await db.from('workshop_invoices').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'GET or DELETE only' })
})

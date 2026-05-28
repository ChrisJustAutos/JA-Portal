// pages/api/workshop/invoices/index.ts
// GET  ?status=&view=&q=  — list invoices for the invoices board.
//                          view: 'active' (default) | 'trash'
//                          status: filter on workshop_invoices.status (free-form)
//                          q: customer name search
//                          paid: 'paid' | 'unpaid' | (any)
//                          source: 'imported' | 'portal' | (any)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

export const config = { maxDuration: 15 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('view:diary', async (req, res) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }
  const db = sb()
  const view = String(req.query.view || 'active').trim()
  const status = String(req.query.status || '').trim()
  const paid = String(req.query.paid || '').trim()
  const source = String(req.query.source || '').trim()
  const q = String(req.query.q || '').trim()
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
  const offset = Math.max(0, Number(req.query.offset) || 0)

  let qy = db.from('workshop_invoices')
    .select(`id, status, subtotal, gst, total, due_date, created_at, deleted_at,
             booking_id, md_id, myob_invoice_uid,
             customer:workshop_customers(id, name, mobile),
             payments:workshop_payments(amount, deleted_at)`, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (view === 'trash') qy = qy.not('deleted_at', 'is', null)
  else qy = qy.is('deleted_at', null)
  if (status) qy = qy.eq('status', status)
  if (source === 'imported') qy = qy.not('md_id', 'is', null)
  else if (source === 'portal') qy = qy.is('md_id', null)

  const { data, count, error } = await qy
  if (error) return res.status(500).json({ error: error.message })

  // Compute paid/outstanding per invoice in JS.
  const rows = (data || []).map((r: any) => {
    const totalPaid = (r.payments || []).filter((p: any) => !p.deleted_at).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0)
    const outstanding = (Number(r.total) || 0) - totalPaid
    const isPaid = outstanding <= 0.01
    return { ...r, paid_total: totalPaid, outstanding, is_paid: isPaid }
  })

  let filtered = rows
  if (paid === 'paid') filtered = rows.filter(r => r.is_paid)
  else if (paid === 'unpaid') filtered = rows.filter(r => !r.is_paid)
  if (q) {
    const qn = q.toLowerCase()
    filtered = filtered.filter(r => String(r.customer?.name || '').toLowerCase().includes(qn) || String(r.md_id || '').includes(q))
  }

  return res.status(200).json({ invoices: filtered, total: count || 0 })
})

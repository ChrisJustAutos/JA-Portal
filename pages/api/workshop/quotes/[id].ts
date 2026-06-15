// pages/api/workshop/quotes/[id].ts
// GET    — quote (+ customer + vehicle) + its lines.       (view:diary)
// PATCH  — status / notes / customer / vehicle.            (edit:bookings)
// DELETE — remove the quote (lines cascade).               (edit:bookings)

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { QUOTE_STATUSES } from '../../../../lib/workshop'
import { notify } from '../../../../lib/notifications'
import { onQuoteStatusChanged } from '../../../../lib/crm-bridge'
import { enrolFromEvent } from '../../../../lib/crm-automation-triggers'
import { queueQuoteFollowUp } from '../../../../lib/workshop-reminders'

export const config = { maxDuration: 10 }

function sb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

const EDITABLE = ['notes', 'customer_id', 'vehicle_id'] as const

export default withAuth('view:diary', async (req, res, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })
  const db = sb()

  if (req.method === 'GET') {
    const { data: quote, error } = await db.from('workshop_quotes')
      .select(`*, customer:workshop_customers(*), vehicle:workshop_vehicles(*)`)
      .eq('id', id).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!quote) return res.status(404).json({ error: 'not_found' })
    const { data: lines } = await db.from('workshop_quote_lines')
      .select('*').eq('quote_id', id).order('sort_order', { ascending: true })
    return res.status(200).json({ quote, lines: lines || [] })
  }

  if (req.method === 'PATCH') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    for (const f of EDITABLE) if (f in body) patch[f] = body[f] === '' ? null : body[f]
    if ('status' in body) {
      if (!QUOTE_STATUSES.includes(body.status)) return res.status(400).json({ error: 'invalid status' })
      patch.status = body.status
    }
    // Capture the prior status so we only notify on a real transition.
    let prevStatus: string | null = null
    if (patch.status) {
      const { data: prev } = await db.from('workshop_quotes').select('status').eq('id', id).maybeSingle()
      prevStatus = prev?.status || null
    }
    const { error } = await db.from('workshop_quotes').update(patch).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    // Any real status transition → reflect on the linked CRM lead (timeline
    // activity + configurable stage move + automations), and fire the
    // quote_accepted/declined flow triggers.
    if (patch.status && patch.status !== prevStatus) {
      const { data: qq } = await db.from('workshop_quotes').select('id, customer_id, total').eq('id', id).maybeSingle()
      if (qq) {
        await onQuoteStatusChanged(db, qq, prevStatus, patch.status, user.id)
        // Quote sent → schedule template-driven follow-up chases.
        if (patch.status === 'sent') await queueQuoteFollowUp(id)
        if (patch.status === 'accepted' || patch.status === 'declined') {
          const { data: lead } = await db.from('crm_leads').select('id, contact_id').eq('workshop_quote_id', id).is('deleted_at', null).maybeSingle()
          const { data: ct } = !lead && qq.customer_id
            ? await db.from('crm_contacts').select('id').eq('workshop_customer_id', qq.customer_id).is('deleted_at', null).maybeSingle()
            : { data: null as any }
          await enrolFromEvent(db, patch.status === 'accepted' ? 'quote_accepted' : 'quote_declined', {
            lead_id: lead?.id || null, contact_id: lead?.contact_id || ct?.id || null,
            quote_id: id, dedupe_key: `quote:${id}:${patch.status}`,
          })
        }
      }
    }

    // Quote accepted/declined → badge the Quotes tile for the team.
    if (patch.status && patch.status !== prevStatus && ['accepted', 'declined'].includes(patch.status)) {
      const { data: q } = await db.from('workshop_quotes')
        .select('total, customer:workshop_customers(name)').eq('id', id).maybeSingle()
      const cust: any = Array.isArray(q?.customer) ? q!.customer[0] : q?.customer
      await notify({
        module: 'workshop-quotes',
        title: `Quote ${patch.status}`,
        body: [cust?.name || null, q?.total ? `$${Number(q.total).toFixed(2)}` : null].filter(Boolean).join(' — ') || null,
        href: '/workshop/quotes',
        roles: ['admin', 'manager', 'workshop'],
        excludeUserId: user.id,
        dedupeKey: `quote-${patch.status}:${id}`,
      })
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!roleHasPermission(user.role, 'edit:bookings')) return res.status(403).json({ error: 'Forbidden' })
    // Soft delete — moves to trash. Pass ?hard=1 to wipe (admin only).
    const hard = String(req.query.hard || '') === '1'
    if (hard) {
      if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only for hard delete' })
      const { error } = await db.from('workshop_quotes').delete().eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ ok: true, hard: true })
    }
    const { error } = await db.from('workshop_quotes').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE')
  return res.status(405).json({ error: 'GET, PATCH or DELETE only' })
})

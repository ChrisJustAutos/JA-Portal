// pages/api/ap/[id]/triage-override.ts
// Set or clear the persistent triage override on an AP invoice.
//
// POST   /api/ap/{id}/triage-override   body: { reason?: string }   → sets triage_override='green'
// DELETE /api/ap/{id}/triage-override                                → clears override
//
// Re-runs applyTriageAndResolve so triage_status / triage_reasons reflect
// the new effective state immediately. Posted invoices are read-only.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'
import { applyTriageAndResolve } from '../../../../lib/ap-supabase'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

export default withAuth('edit:supplier_invoices', async (req: NextApiRequest, res: NextApiResponse, user) => {
  const id = String(req.query.id || '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const c = sb()
  const { data: inv, error: invErr } = await c
    .from('ap_invoices')
    .select('id, status, triage_status')
    .eq('id', id)
    .maybeSingle()
  if (invErr) return res.status(500).json({ error: invErr.message })
  if (!inv)   return res.status(404).json({ error: 'Invoice not found' })
  if (inv.status === 'posted') {
    return res.status(409).json({ error: 'Cannot override triage on a posted invoice' })
  }

  if (req.method === 'POST') {
    const body = (req.body || {}) as { reason?: string }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

    const { error } = await c
      .from('ap_invoices')
      .update({
        triage_override:        'green',
        triage_override_reason: reason || null,
        triage_override_by:     user.id,
        triage_override_at:     new Date().toISOString(),
      })
      .eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    try { await applyTriageAndResolve(id) } catch (e: any) {
      console.error('Re-triage after override-set failed:', e?.message)
    }
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { error } = await c
      .from('ap_invoices')
      .update({
        triage_override:        null,
        triage_override_reason: null,
        triage_override_by:     null,
        triage_override_at:     null,
      })
      .eq('id', id)
    if (error) return res.status(500).json({ error: error.message })

    try { await applyTriageAndResolve(id) } catch (e: any) {
      console.error('Re-triage after override-clear failed:', e?.message)
    }
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed — use POST or DELETE' })
})

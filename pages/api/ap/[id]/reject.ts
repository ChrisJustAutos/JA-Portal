// pages/api/ap/[id]/reject.ts
// POST /api/ap/{id}/reject — marks the invoice rejected (no MYOB write).
//
// Body: { reason: string } — required, stored in rejection_reason.
//
// Returns:
//   200 { ok: true }
//   409 if already posted (rejecting a posted bill makes no sense — handle
//       in MYOB instead)

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth(null, async (req: NextApiRequest, res: NextApiResponse, user: any) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!roleHasPermission(user.role, 'edit:supplier_invoices')) {
    return res.status(403).json({ error: 'Forbidden — edit:supplier_invoices required' })
  }

  const id = String(req.query.id || '')
  if (!id) return res.status(400).json({ error: 'invoice id required' })

  const reason = String((req.body || {}).reason || '').trim()
  if (!reason) return res.status(400).json({ error: 'reason is required' })
  if (reason.length > 1000) return res.status(400).json({ error: 'reason must be ≤ 1000 chars' })

  const c = sb()

  // Idempotency / state check
  const { data: inv, error: fetchErr } = await c
    .from('ap_invoices')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!inv)     return res.status(404).json({ error: 'Invoice not found' })

  if (inv.status === 'posted') {
    return res.status(409).json({ error: 'Cannot reject — invoice already posted to MYOB. Reverse in MYOB instead.' })
  }
  if (inv.status === 'rejected') {
    return res.status(200).json({ ok: true, alreadyRejected: true })
  }

  const { error: updErr } = await c
    .from('ap_invoices')
    .update({
      status: 'rejected',
      rejection_reason: reason,
    })
    .eq('id', id)
  if (updErr) return res.status(500).json({ error: updErr.message })

  return res.status(200).json({ ok: true })
})

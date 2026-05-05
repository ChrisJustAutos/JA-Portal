// pages/api/ap/[id]/unpost.ts
// POST /api/ap/{id}/unpost — resets a previously posted invoice back to
// pending_review so it can be re-approved. Use case: a bill was posted
// to MYOB, then deleted manually in MYOB, and now the invoice can't be
// re-entered from the portal because our DB still says it's posted (and
// any subsequent approve attempt would short-circuit).
//
// Behaviour:
//   - Validates the invoice is currently `posted`. Anything else → 409.
//   - Clears MYOB linkage fields (bill UID, posted_at, posted_by,
//     bill_row_id) so the next Approve attempt does a fresh post.
//   - Records an audit note in `myob_post_error` (used as a
//     general-purpose annotation field) — captures who un-posted, when,
//     the previous bill UID, and an optional reason.
//   - Re-runs triage so the invoice returns to its previous
//     green/yellow/red state and supplier/account are re-resolved in
//     case anything changed in the meantime.
//
// Safety net: when the user re-approves after un-posting, the
// findExistingMyobBill pre-flight in lib/ap-myob-bill.ts will detect
// any still-existing MYOB bill with the same SupplierInvoiceNumber +
// Supplier UID and adopt that UID instead of creating a duplicate.
// So if the user un-posts by mistake, re-approving is safe — it'll
// just re-link to the same bill.
//
// Body (optional):
//   { reason?: string }   reason for un-posting (e.g. "deleted in MYOB"),
//                         max 1000 chars. Stored in the audit note.
//
// Returns:
//   200 { ok: true, previousMyobBillUid, note }
//   409 if the invoice isn't currently posted
//   404 if the invoice doesn't exist

import type { NextApiRequest, NextApiResponse } from 'next'
import { withAuth } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'
import { createClient } from '@supabase/supabase-js'
import { applyTriageAndResolve } from '../../../../lib/ap-supabase'

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
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'reason must be ≤ 1000 chars' })
  }

  const c = sb()

  const { data: inv, error: fetchErr } = await c
    .from('ap_invoices')
    .select('id, status, myob_bill_uid, vendor_name_parsed, invoice_number')
    .eq('id', id)
    .maybeSingle()
  if (fetchErr) return res.status(500).json({ error: fetchErr.message })
  if (!inv)     return res.status(404).json({ error: 'Invoice not found' })

  if (inv.status !== 'posted') {
    return res.status(409).json({
      error: `Cannot un-post — invoice status is "${inv.status}", not "posted"`,
    })
  }

  const previousMyobBillUid: string | null = inv.myob_bill_uid

  // Build an audit note. Stored in myob_post_error which we treat as a
  // general-purpose annotation field for posting-related state changes.
  const who = (user as any)?.email || (user as any)?.displayName || 'admin'
  const noteParts: string[] = [
    `Un-posted by ${who} at ${new Date().toISOString()}`,
  ]
  if (previousMyobBillUid) {
    noteParts.push(`previous MYOB bill UID ${previousMyobBillUid.substring(0, 8)}…`)
  }
  if (reason) noteParts.push(`reason: ${reason.substring(0, 300)}`)
  const unpostNote = noteParts.join(' · ').substring(0, 500)

  // Reset MYOB linkage fields. We deliberately keep `myob_post_attempts`
  // as-is — it's a count of attempts ever made, not a state. The smart-
  // adopt path on the next post will increment it again.
  const { error: updErr } = await c
    .from('ap_invoices')
    .update({
      status:           'pending_review',
      myob_bill_uid:    null,
      myob_bill_row_id: null,
      myob_posted_at:   null,
      myob_posted_by:   null,
      myob_post_error:  unpostNote,
    })
    .eq('id', id)

  if (updErr) return res.status(500).json({ error: updErr.message })

  // Re-run triage so the invoice returns to whatever state it was in
  // before being posted (typically green or yellow). applyTriageAndResolve
  // also writes status='pending_review' at the end, so it's idempotent
  // with our update above. Failure here is non-fatal — the invoice is
  // already un-posted; triage can be redone via any subsequent edit.
  try {
    await applyTriageAndResolve(id)
  } catch (e: any) {
    console.error(`unpost: re-triage failed for ${id}: ${e?.message}`)
  }

  return res.status(200).json({
    ok: true,
    previousMyobBillUid,
    note: unpostNote,
  })
})

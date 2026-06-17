// pages/api/workshop/job-types/[id]/apply.ts
// POST { booking_id, lines_only? } — copy a job type's template lines AND its
// work-done description onto a booking. Lines are appended after any existing
// lines. The description is set if the booking has none, or appended (with a
// blank line between) if it already has one — so the same text shows on the
// invoice AND on the job-card checklist. Pass `lines_only: true` when the
// caller has already set the description (e.g. the diary booking modal).
// Gated edit:bookings.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { applyJobTypeToBooking } from '../../../../../lib/workshop-job-type-apply'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('edit:bookings', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const jobTypeId = String(req.query.id || '').trim()
  if (!jobTypeId) return res.status(400).json({ error: 'job type id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const bookingId = String(body.booking_id || '').trim()
  if (!bookingId) return res.status(400).json({ error: 'booking_id required' })

  const r = await applyJobTypeToBooking(sb(), jobTypeId, bookingId, user.displayName || user.email || user.id)
  if (!r.ok) return res.status(r.error === 'job type not found' ? 404 : 500).json({ error: r.error })
  return res.status(200).json({ ok: true, added: r.added, job_type: r.jobTypeLabel })
})

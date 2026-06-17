// pages/api/workshop/job-type-packages/[id]/apply.ts
// POST { booking_id } | { quote_id } — apply every member job type of a package,
// in order, to a booking (invoice/job card) or a quote. Reuses the shared
// job-type apply logic so each member drops its own [description] + parts block,
// identical to applying the job types one by one. Gated edit:bookings.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { applyJobTypeToBooking, applyJobTypeToQuote } from '../../../../../lib/workshop-job-type-apply'

export const config = { maxDuration: 20 }

function sb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

export default withAuth('edit:bookings', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const packageId = String(req.query.id || '').trim()
  if (!packageId) return res.status(400).json({ error: 'package id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const bookingId = String(body.booking_id || '').trim()
  const quoteId = String(body.quote_id || '').trim()
  if (!bookingId && !quoteId) return res.status(400).json({ error: 'booking_id or quote_id required' })
  if (bookingId && quoteId) return res.status(400).json({ error: 'Pass either booking_id or quote_id, not both' })

  const db = sb()
  const { data: pkg } = await db.from('workshop_job_type_packages').select('id, name').eq('id', packageId).maybeSingle()
  if (!pkg) return res.status(404).json({ error: 'package not found' })

  const { data: items } = await db.from('workshop_job_type_package_items')
    .select('job_type_id, sort_order').eq('package_id', packageId).order('sort_order', { ascending: true })
  if (!items || items.length === 0) return res.status(400).json({ error: 'This package has no job types in it.' })

  const actor = user.displayName || user.email || user.id
  let totalAdded = 0
  const members: { job_type: string | null; added: number }[] = []
  for (const it of items as any[]) {
    const r = bookingId
      ? await applyJobTypeToBooking(db, it.job_type_id, bookingId, actor)
      : await applyJobTypeToQuote(db, it.job_type_id, quoteId, actor)
    if (r.ok) { totalAdded += r.added; members.push({ job_type: r.jobTypeLabel, added: r.added }) }
    // A missing/deleted member job type is skipped rather than failing the lot.
  }

  return res.status(200).json({ ok: true, package: (pkg as any).name, added: totalAdded, members })
})

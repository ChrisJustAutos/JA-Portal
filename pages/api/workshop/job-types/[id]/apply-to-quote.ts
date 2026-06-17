// pages/api/workshop/job-types/[id]/apply-to-quote.ts
// POST { quote_id, append_notes? } — copy a job type's template lines onto a
// quote (workshop_quote_lines). Sibling of /apply (which targets bookings).
// Converts the ex-GST template price to inc-GST for the quote's single price
// field. Appends the job type's description to the quote's notes when
// append_notes is true (default).

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../../lib/authServer'
import { applyJobTypeToQuote } from '../../../../../lib/workshop-job-type-apply'

export const config = { maxDuration: 10 }

function sb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default withAuth('edit:bookings', async (req, res, user) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }) }
  const jobTypeId = String(req.query.id || '').trim()
  if (!jobTypeId) return res.status(400).json({ error: 'job type id required' })
  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }
  const quoteId = String(body.quote_id || '').trim()
  if (!quoteId) return res.status(400).json({ error: 'quote_id required' })

  const r = await applyJobTypeToQuote(sb(), jobTypeId, quoteId, user.displayName || user.email || user.id)
  if (!r.ok) return res.status(r.error === 'job type not found' ? 404 : 500).json({ error: r.error })
  // Preserve the original endpoint's behaviour: a job type with nothing to add is a 400.
  if (r.added === 0) return res.status(400).json({ error: 'This job type has no template lines.' })
  return res.status(200).json({ ok: true, added: r.added, job_type: r.jobTypeLabel })
})

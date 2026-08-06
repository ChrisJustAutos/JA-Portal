// pages/api/b2b/training/nav-count.ts
// How many training modules are visible to the signed-in membership.
//   GET → { count }
// Powers the conditional "Training" item in B2BLayout's nav — the tab only
// renders when count > 0, so distributors with no assigned coursework never
// see it. Deliberately tiny (two indexed selects) as it's fetched once per
// page mount.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withB2BAuth, B2BUser } from '../../../../lib/b2bAuthServer'
import { asMembershipId, assignedModuleIds } from '../../../../lib/b2b-training'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withB2BAuth(async (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  const assigned = await assignedModuleIds(user.distributor.id, asMembershipId(user.id))
  if (assigned.size === 0) return res.status(200).json({ count: 0 })

  const { data, error } = await sb()
    .from('b2b_training_modules')
    .select('id')
    .eq('enabled', true)
  if (error) return res.status(500).json({ error: error.message })

  const count = (data || []).filter(m => assigned.has(m.id)).length
  return res.status(200).json({ count })
})

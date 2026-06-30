// pages/api/agents/findings/[id].ts
// PATCH — decide a finding: { action: 'dismiss' | 'done' | 'approve' }.
// (approve currently just records approval; executing the suggested_action is
// wired in a later phase alongside the autonomy gate.) Gated on view:agents.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const ACTION_TO_STATUS: Record<string, string> = {
  dismiss: 'dismissed',
  done: 'done',
  approve: 'approved',
}

export default withAuth('view:agents', async (req: NextApiRequest, res: NextApiResponse, user) => {
  if (req.method !== 'PATCH') { res.setHeader('Allow', 'PATCH'); return res.status(405).json({ error: 'PATCH only' }) }
  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'Missing id' })

  const action = (req.body || {}).action
  const status = ACTION_TO_STATUS[action]
  if (!status) return res.status(400).json({ error: "action must be 'dismiss' | 'done' | 'approve'" })

  const { data, error } = await sb().from('agent_findings')
    .update({ status, decided_by: user.id, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle()
  if (error) return res.status(500).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Not found' })
  return res.status(200).json(data)
})

// pages/api/agents/findings.ts
// GET — list agent findings for the inbox. Filters: ?status=open|all|<status>,
// ?agent=comms, ?severity=warn. Default = open (new + awaiting_approval).

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const OPEN_STATUSES = ['new', 'awaiting_approval', 'approved']

export default withAuth('view:agents', async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }) }

  let q = sb().from('agent_findings')
    .select('id, agent, kind, severity, confidence, title, body, href, suggested_action, status, payload, created_at, updated_at, decided_at')
    .order('created_at', { ascending: false })
    .limit(200)

  const status = String(req.query.status || 'open')
  if (status === 'open') q = q.in('status', OPEN_STATUSES)
  else if (status !== 'all') q = q.eq('status', status)
  if (req.query.agent) q = q.eq('agent', String(req.query.agent))
  if (req.query.severity) q = q.eq('severity', String(req.query.severity))

  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ findings: data || [] })
})

// pages/api/cron/agents.ts
// Runs the monitoring agents. Vercel cron sends CRON_SECRET; a logged-in
// staffer with view:agents can also trigger from the browser:
//   /api/cron/agents?dry=1            (preview all, no writes)
//   /api/cron/agents?agent=comms      (run one)

import type { NextApiRequest, NextApiResponse } from 'next'
import { runAgentById, runAllAgents } from '../../../lib/agent-framework'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const bearerOk = !!process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'view:agents')) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const dry = req.query.dry === '1'
  const agent = typeof req.query.agent === 'string' ? req.query.agent : ''
  try {
    const outcome = agent
      ? [await runAgentById(agent, { dryRun: dry })]
      : await runAllAgents({ dryRun: dry })
    return res.status(200).json({ ok: true, dryRun: dry, outcome })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: (e?.message || String(e)).slice(0, 500) })
  }
}

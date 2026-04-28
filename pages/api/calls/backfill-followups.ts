// pages/api/calls/backfill-followups.ts
// On-demand trigger to drain the follow-up sync queue. Auth-protected
// (CRON_SECRET) so it can be hit from a browser or curl when you want to
// kick processing along without waiting for the next 5-min cron tick.
//
// Mostly a thin wrapper that calls into the cron handler logic — keeps
// the queue draining behaviour single-sourced. Useful for the initial
// rollout when the 500-row historical backlog needs draining.

import type { NextApiRequest, NextApiResponse } from 'next'
import cronHandler from '../cron/sync-followups'

export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Same auth as cron handler — reuse the body for parity with how Vercel
  // would call it. Anyone with CRON_SECRET can trigger this manually.
  return cronHandler(req, res)
}

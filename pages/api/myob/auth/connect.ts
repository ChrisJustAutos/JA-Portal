// pages/api/myob/auth/connect.ts
// Starts the MYOB OAuth flow. Generates a random CSRF state and persists it
// to Supabase (myob_oauth_state) along with the admin user's ID. The admin
// check happens HERE, before we leave for MYOB, so the callback can trust
// the row's user_id field.
//
// Why server-side state instead of a signed cookie:
//   The post-March 2025 MYOB OAuth flow has multiple redirect hops
//   (login → consent → file picker → allow). Browser cookies, even with
//   SameSite=Lax, proved unreliable across this chain — particularly on
//   Vercel preview URLs. Storing state server-side eliminates the cookie
//   round-trip entirely; the only thing that has to make it back to us is
//   the random `state` value in MYOB's redirect URL, which it always does.

import type { NextApiRequest, NextApiResponse } from 'next'
import { randomBytes } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { requireAdmin, getSessionUser } from '../../../../lib/auth'
import { buildAuthorizeUrl } from '../../../../lib/myob'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAdmin(req, res, async () => {
    const user = await getSessionUser(req)
    if (!user) {
      res.status(401).json({ error: 'No session user' })
      return
    }

    const state = randomBytes(24).toString('hex')
    const label = String(req.query.label || 'JAWS')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 40) || 'JAWS'

    const client = sb()

    // Self-maintaining cleanup: drop any state rows older than 30 minutes
    // before inserting the new one. Cheap and avoids needing a cron job.
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await client.from('myob_oauth_state').delete().lt('created_at', cutoff)

    const { error } = await client.from('myob_oauth_state').insert({
      state,
      label,
      user_id: user.id,
    })
    if (error) {
      res.status(500).json({ error: 'Failed to persist OAuth state: ' + error.message })
      return
    }

    res.writeHead(302, { Location: buildAuthorizeUrl(state) })
    res.end()
  })
}

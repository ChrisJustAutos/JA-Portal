// pages/api/notifications/test.ts
// POST — send the current user a test notification through the real notify()
// pipeline (DB row → bell badge + in-app toast + Web Push). Targets a module
// the user can actually see so the access filter doesn't hide it.

import type { NextApiRequest, NextApiResponse } from 'next'
import { requireAuth, getSessionUser } from '../../../lib/auth'
import { notify } from '../../../lib/notifications'
import { visibleNavSections } from '../../../lib/permissions'

export const config = { maxDuration: 10 }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return requireAuth(req, res, async () => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
    const me = (await getSessionUser(req))!
    const visible = visibleNavSections(me.role, me.visibleTabs)
    const module = visible.find(m => m !== 'settings') || 'messages'
    await notify({
      module,
      title: 'Test notification 🎉',
      body: 'If you can see this, portal pop-ups are working.',
      href: '/home',
      userIds: [me.id],
      // No dedupeKey → a fresh row every time, so repeat tests always fire.
    })
    return res.status(200).json({ ok: true })
  })
}

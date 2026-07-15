// pages/api/admin/slack-diag.ts
//
// Diagnostic for the portal's Slack bot token: who is it, which scopes does
// it ACTUALLY carry (Slack returns them in the x-oauth-scopes header), and
// can it read the two customer-feedback channels. Built 2026-07-16 while
// chasing missing_scope on the sales report's feedback panels — tells apart
// "wrong app edited" / "scope on User instead of Bot" / "token rotated on
// reinstall" in one call. Open in a logged-in browser; the result is also
// console.logged so it shows in Vercel runtime logs.
//
// Auth: staff with view:reports.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

const CHANNELS = [
  { label: '#customer-feedback-negative', id: process.env.CONCERN_SLACK_CHANNEL || 'G01GB6P2MU1' },
  { label: '#customer-feedback-positive', id: process.env.SLACK_FEEDBACK_POSITIVE_CHANNEL || 'C05UVDQ96ES' },
]

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) return res.status(401).json({ error: 'Unauthorised' })

  const token = (process.env.SLACK_BOT_TOKEN || '').trim()
  if (!token) return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set' })

  const auth = await fetch('https://slack.com/api/auth.test', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  })
  const scopes = auth.headers.get('x-oauth-scopes') || '(header absent)'
  const who: any = await auth.json()

  const channels: any[] = []
  for (const ch of CHANNELS) {
    const r = await fetch(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(ch.id)}&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j: any = await r.json()
    channels.push({ ...ch, ok: !!j.ok, error: j.ok ? null : j.error, sampleMessages: j.ok ? (j.messages || []).length : 0 })
  }

  const out = {
    tokenPrefix: `${token.slice(0, 10)}…`,
    bot: { ok: !!who.ok, user: who.user || null, botId: who.bot_id || null, team: who.team || null, error: who.ok ? null : who.error },
    grantedScopes: scopes,
    hasGroupsHistory: /(^|,)groups:history(,|$)/.test(scopes),
    hasUsersRead: /(^|,)users:read(,|$)/.test(scopes),
    channels,
  }
  console.log('[slack-diag]', JSON.stringify(out))
  return res.status(200).json(out)
}

// pages/api/reports/sales-recap/run.ts
//
// Kicks off the Weekly Sales Recap GH-Actions job on demand from the portal.
// The workshop forecast + diary need a Playwright scrape (GH-Actions only), so
// "run now" dispatches that workflow rather than doing the work inline.
//   action 'refresh' → scrape MD + store (updates the live view), NO email
//   action 'send'    → scrape MD + store + EMAIL the team now
//
// Auth: staff with view:reports. Uses GH_DISPATCH_TOKEN (needs actions:write).

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../../lib/authServer'
import { roleHasPermission } from '../../../../lib/permissions'

const REPO = 'ChrisJustAutos/JA-Portal'
const WORKFLOW = 'sales-recap.yml'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getCurrentUser(req)
  if (!user || !roleHasPermission(user.role, 'view:reports')) return res.status(401).json({ error: 'Unauthorised' })
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const token = process.env.GH_DISPATCH_TOKEN
  if (!token) return res.status(500).json({ error: 'GH_DISPATCH_TOKEN not set in environment' })

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  const action = body.action === 'send' ? 'send' : 'refresh'
  const mode = action === 'send' ? 'real' : 'refresh' // workflow input

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { mode } }),
    })
    if (r.status !== 204) {
      const txt = await r.text().catch(() => '')
      return res.status(502).json({ error: `GitHub dispatch failed (${r.status})`, detail: txt.slice(0, 300) })
    }
    return res.status(200).json({ ok: true, action, mode })
  } catch (e: any) {
    return res.status(500).json({ error: (e?.message || String(e)).slice(0, 300) })
  }
}

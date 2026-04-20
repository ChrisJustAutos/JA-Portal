// pages/api/myob/auth/callback.ts
// MYOB redirects here after the user authorises. We verify the state cookie,
// exchange the code for tokens, save the connection, then redirect the admin
// to the settings page where they'll pick a company file.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getSessionUser } from '../../../../lib/auth'
import { exchangeCodeForTokens, saveConnection } from '../../../../lib/myob'

function renderError(res: NextApiResponse, msg: string) {
  res.status(400).setHeader('Content-Type', 'text/html')
  res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0d0f12;color:#e8eaf0">
    <h2 style="color:#f04e4e">MYOB connection failed</h2>
    <p>${msg.replace(/</g, '&lt;')}</p>
    <p><a href="/settings?tab=myob" style="color:#4f8ef7">← Back to settings</a></p>
  </body></html>`)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req)
  if (!user || user.role !== 'admin') {
    return renderError(res, 'Admin session required. Please sign in as admin, then retry.')
  }

  const code = String(req.query.code || '')
  const stateFromUrl = String(req.query.state || '')
  const errFromMyob = req.query.error ? String(req.query.error) : null
  if (errFromMyob) return renderError(res, `MYOB returned error: ${errFromMyob} — ${req.query.error_description || ''}`)
  if (!code) return renderError(res, 'No authorisation code returned from MYOB.')

  const stateCookie = req.cookies['myob-oauth-state']
  if (!stateCookie) return renderError(res, 'OAuth state cookie missing — maybe too much time passed. Please retry.')
  const [stateFromCookie, label] = stateCookie.split(':')
  if (!stateFromCookie || stateFromCookie !== stateFromUrl) {
    return renderError(res, 'OAuth state mismatch — possible CSRF or expired session. Please retry.')
  }

  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveConnection(label || 'JAWS', tokens, user.id)
    // Clear the state cookie
    res.setHeader('Set-Cookie', 'myob-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    // Redirect to settings MYOB tab — user needs to pick a company file next
    res.writeHead(302, { Location: `/settings?tab=myob&connected=${encodeURIComponent(label || 'JAWS')}` })
    res.end()
  } catch (e: any) {
    return renderError(res, e?.message || 'Token exchange failed')
  }
}

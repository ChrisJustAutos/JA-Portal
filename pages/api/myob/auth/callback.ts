// pages/api/myob/auth/callback.ts
// MYOB redirects here after the user authorises. We verify the state cookie,
// exchange the code for tokens, save the connection, then redirect the admin
// to the settings page where they'll pick a company file.

import type { NextApiRequest, NextApiResponse } from 'next'
import { getSessionUser } from '../../../../lib/auth'
import { exchangeCodeForTokens, saveConnection } from '../../../../lib/myob'

function renderError(res: NextApiResponse, msgHtml: string) {
  // msgHtml may contain safe HTML. Callers of this function must have already
  // escaped any untrusted content. MYOB error codes from query.error are
  // already constrained by MYOB's OAuth spec so are not user-supplied.
  res.status(400).setHeader('Content-Type', 'text/html')
  res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0d0f12;color:#e8eaf0;line-height:1.5">
    <h2 style="color:#f04e4e">MYOB connection failed</h2>
    <div>${msgHtml}</div>
    <p style="margin-top:20px"><a href="/settings?tab=myob" style="color:#4f8ef7">← Back to settings</a></p>
  </body></html>`)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Check for MYOB-returned errors FIRST — these happen when MYOB rejects
  // the authorisation request (invalid scope, invalid client_id, user denied,
  // etc). Showing "admin session required" for these is misleading.
  const errFromMyob = req.query.error ? String(req.query.error) : null
  if (errFromMyob) {
    const desc = req.query.error_description ? String(req.query.error_description) : ''
    return renderError(res,
      `MYOB rejected the authorisation request. ` +
      `Error: <code>${errFromMyob}</code>` +
      (desc ? `<br/>Description: ${desc}` : '') +
      `<br/><br/>Most common causes:` +
      `<ul style="margin-top:8px">` +
      `<li><code>invalid_scope</code> — the scope value in the portal's OAuth code doesn't match what MYOB expects for your app. Admin needs to update <code>lib/myob.ts</code>.</li>` +
      `<li><code>unauthorized_client</code> — MYOB app is still pending approval, or client_id/secret mismatch.</li>` +
      `<li><code>redirect_uri_mismatch</code> — MYOB_REDIRECT_URI in Vercel doesn't exactly match the registered redirect URI in MYOB's developer portal.</li>` +
      `</ul>`)
  }

  // Admin session check — must be after MYOB error check.
  const user = await getSessionUser(req)
  if (!user || user.role !== 'admin') {
    return renderError(res,
      'Admin session required. Please sign in as admin in the portal, then retry the connection.' +
      '<br/><br/><em>If you just came from MYOB and think you ARE signed in, your session cookie may have been lost on the cross-site redirect. Try returning to /settings first and then retrying.</em>')
  }

  const code = String(req.query.code || '')
  const stateFromUrl = String(req.query.state || '')
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

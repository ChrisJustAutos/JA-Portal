// pages/api/myob/auth/callback.ts
// MYOB redirects here after the user authorises. Instead of re-verifying the
// Supabase session (which can be lost on cross-site redirects), we trust the
// signed state cookie that connect.ts set — it was signed with our service-role
// key so only our own /connect endpoint could have issued it, and the admin
// check was already enforced there. Any failure to validate the signed cookie
// = abort.
//
// Post-March 2025 OAuth changes:
//   When `prompt=consent` is set on the authorise URL (see lib/myob.ts
//   buildAuthorizeUrl()), MYOB returns a `businessId` query parameter on
//   this callback URL. That businessId IS the company file GUID — for new
//   keys it replaces the old "list company files, pick one" flow. We
//   capture it here and persist it onto the connection alongside the tokens.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createHmac, timingSafeEqual } from 'crypto'
import { exchangeCodeForTokens, saveConnection } from '../../../../lib/myob'

function renderError(res: NextApiResponse, msgHtml: string) {
  res.status(400).setHeader('Content-Type', 'text/html')
  res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0d0f12;color:#e8eaf0;line-height:1.5">
    <h2 style="color:#f04e4e">MYOB connection failed</h2>
    <div>${msgHtml}</div>
    <p style="margin-top:20px"><a href="/settings?tab=myob" style="color:#4f8ef7">← Back to settings</a></p>
  </body></html>`)
}

// Verify and unpack the signed state cookie. Returns { state, label, userId }
// or null if tampered/invalid.
function verifyStateCookie(cookie: string): { state: string; label: string; userId: string } | null {
  const lastDot = cookie.lastIndexOf('.')
  if (lastDot <= 0) return null
  const payload = cookie.substring(0, lastDot)
  const sig = cookie.substring(lastDot + 1)
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || 'fallback-dev-secret'
  const expected = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16)
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return null
    if (!timingSafeEqual(a, b)) return null
  } catch { return null }
  const parts = payload.split(':')
  if (parts.length !== 3) return null
  return { state: parts[0], label: parts[1], userId: parts[2] }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Check MYOB-returned errors first
  const errFromMyob = req.query.error ? String(req.query.error) : null
  if (errFromMyob) {
    const desc = req.query.error_description ? String(req.query.error_description) : ''
    return renderError(res,
      `MYOB rejected the authorisation request. Error: <code>${errFromMyob}</code>` +
      (desc ? `<br/>Description: ${desc}` : ''))
  }

  const code = String(req.query.code || '')
  const stateFromUrl = String(req.query.state || '')
  // businessId is the company file GUID, returned only when prompt=consent
  // is on the authorise URL. Empty for legacy/pre-March 2025 keys.
  const businessId = req.query.businessId ? String(req.query.businessId) : null
  if (!code) return renderError(res, 'No authorisation code returned from MYOB.')

  // Verify signed state cookie (replaces session check — was flaky across cross-site redirect)
  const stateCookie = req.cookies['myob-oauth-state']
  if (!stateCookie) {
    return renderError(res,
      'OAuth state cookie missing. This usually means either the session expired (10-min limit) ' +
      'or the connection was not started from this browser. Please retry from Settings.')
  }
  const unpacked = verifyStateCookie(stateCookie)
  if (!unpacked) {
    return renderError(res,
      'OAuth state cookie failed signature check. Cookie may be tampered or from a different deployment. Please retry.')
  }
  if (unpacked.state !== stateFromUrl) {
    return renderError(res, 'OAuth state mismatch — possible CSRF or expired session. Please retry.')
  }

  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveConnection(unpacked.label || 'JAWS', tokens, unpacked.userId, businessId)
    res.setHeader('Set-Cookie', 'myob-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    const qs = new URLSearchParams({
      tab: 'myob',
      connected: unpacked.label || 'JAWS',
    })
    if (businessId) qs.append('businessId', businessId)
    res.writeHead(302, { Location: `/settings?${qs.toString()}` })
    res.end()
  } catch (e: any) {
    return renderError(res, e?.message || 'Token exchange failed')
  }
}

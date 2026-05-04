// pages/api/myob/auth/callback.ts
// MYOB redirects here after the user authorises. Looks up the random state
// in Supabase (set by connect.ts), verifies age, exchanges the code for
// tokens, and persists the connection.
//
// Server-side state replaces the previous cookie-based flow which proved
// unreliable across MYOB's multi-redirect consent flow. The state row is
// consumed (deleted) on every callback — successful or not — to prevent
// replay of either the state value or the OAuth code.
//
// Post-March 2025 OAuth: when `prompt=consent` is set on the authorise URL
// (see lib/myob.ts buildAuthorizeUrl()), MYOB returns BOTH `businessId` AND
// `businessName` query parameters:
//   businessId   = company file GUID (used as company_file_id)
//   businessName = display name like "Just Autos Wholesale" (used as
//                  company_file_name so the UI shows it instead of
//                  "— not selected —").
// For new keys this entirely replaces the legacy "list company files +
// pick one" flow.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { exchangeCodeForTokens, saveConnection } from '../../../../lib/myob'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

function renderError(res: NextApiResponse, msgHtml: string) {
  res.status(400).setHeader('Content-Type', 'text/html')
  res.send(`<!doctype html><html><body style="font-family:system-ui;padding:40px;background:#0d0f12;color:#e8eaf0;line-height:1.5">
    <h2 style="color:#f04e4e">MYOB connection failed</h2>
    <div>${msgHtml}</div>
    <p style="margin-top:20px"><a href="/settings?tab=myob" style="color:#4f8ef7">← Back to settings</a></p>
  </body></html>`)
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // MYOB-side errors (e.g. user denied consent, scope rejected) come back
  // as ?error=... query params — render those before doing any state work.
  const errFromMyob = req.query.error ? String(req.query.error) : null
  if (errFromMyob) {
    const desc = req.query.error_description ? String(req.query.error_description) : ''
    return renderError(res,
      `MYOB rejected the authorisation request. Error: <code>${errFromMyob}</code>` +
      (desc ? `<br/>Description: ${desc}` : ''))
  }

  const code = String(req.query.code || '')
  const stateFromUrl = String(req.query.state || '')
  // businessId + businessName are returned only when prompt=consent is set
  // on the authorise URL. Empty for legacy/pre-March 2025 keys.
  const businessId   = req.query.businessId   ? String(req.query.businessId)   : null
  const businessName = req.query.businessName ? String(req.query.businessName) : null

  if (!code) return renderError(res, 'No authorisation code returned from MYOB.')
  if (!stateFromUrl) return renderError(res, 'No state parameter returned from MYOB.')

  const client = sb()

  // Look up the state row that connect.ts inserted.
  const { data: stateRow, error: stateErr } = await client
    .from('myob_oauth_state')
    .select('state, label, user_id, created_at')
    .eq('state', stateFromUrl)
    .maybeSingle()

  if (stateErr) {
    return renderError(res, 'Database error looking up OAuth state: ' + stateErr.message)
  }
  if (!stateRow) {
    return renderError(res,
      'OAuth state not found. The connection may have been started in a different session, ' +
      'or the state has already been consumed (do not retry the same callback URL — start over from Settings).')
  }

  // Age check — 30 minute window. MYOB's new consent flow can take a few
  // minutes if the user has multiple files / 2FA / etc.
  const ageMs = Date.now() - new Date(stateRow.created_at).getTime()
  if (ageMs > 30 * 60 * 1000) {
    await client.from('myob_oauth_state').delete().eq('state', stateFromUrl)
    return renderError(res, 'OAuth state expired (>30 min). Please retry from Settings.')
  }

  // Consume the state row immediately. From this point even if token exchange
  // fails, the state cannot be reused — replay attacks blocked.
  await client.from('myob_oauth_state').delete().eq('state', stateFromUrl)

  try {
    const tokens = await exchangeCodeForTokens(code)
    await saveConnection(stateRow.label || 'JAWS', tokens, stateRow.user_id, businessId, businessName)
    const qs = new URLSearchParams({
      tab: 'myob',
      connected: stateRow.label || 'JAWS',
    })
    if (businessId)   qs.append('businessId', businessId)
    if (businessName) qs.append('businessName', businessName)
    res.writeHead(302, { Location: `/settings?${qs.toString()}` })
    res.end()
  } catch (e: any) {
    return renderError(res, e?.message || 'Token exchange failed')
  }
}

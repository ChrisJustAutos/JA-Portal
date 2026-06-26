// pages/api/admin/inspect-stripe-account.ts
//
// Diagnostic — for each configured Stripe key, pings GET /v1/account and
// reports WHICH Stripe account that key belongs to (account id, business name,
// country, mode). Use it to confirm the B2B portal's STRIPE_SECRET_KEY is the
// Just Autos account and not, e.g., the Easy Tune connected account.
//
// Never returns the secret itself — only a short prefix preview (the same
// leading chars Vercel shows) so you can correlate without exposing the key.
//
// Auth: admin session (admin:b2b) OR `Authorization: Bearer $CRON_SECRET`.
//   Browser:  log in as admin, visit /api/admin/inspect-stripe-account
//   curl:     curl -H "Authorization: Bearer $CRON_SECRET" \
//               https://justautos.app/api/admin/inspect-stripe-account

import type { NextApiRequest, NextApiResponse } from 'next'
import { getCurrentUser } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'

const STRIPE_API = 'https://api.stripe.com/v1'

// The keys the app uses. Platform key (STRIPE_SECRET_KEY) is the one the B2B
// portal charges against; the others are connected accounts used only by the
// MYOB payout sync (lib/stripe-multi.ts).
const KEY_ENVS: Array<{ env: string; role: string }> = [
  { env: 'STRIPE_SECRET_KEY',            role: 'B2B portal (checkout + webhook)' },
  { env: 'STRIPE_SECRET_KEY_JAWS_JMACX', role: 'connected account — MYOB payout sync' },
  { env: 'STRIPE_SECRET_KEY_JAWS_ET',    role: 'connected account — MYOB payout sync' },
]

// Show enough of the key to correlate with Vercel (e.g. sk_live_51H8a…) without
// revealing the secret tail.
function preview(k: string): string {
  return k.length > 16 ? `${k.slice(0, 16)}… (${k.length} chars)` : `(${k.length} chars)`
}

async function stripeGet(k: string, path: string): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, { headers: { Authorization: `Bearer ${k}` } })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  if (!res.ok) throw new Error(json?.error?.message || text || `HTTP ${res.status}`)
  return json
}

// List the webhook endpoints registered ON this account. If one points at an
// Easy Tune URL, that's the routing culprit. (Note: this does NOT show a
// parent platform's Connect webhook — those live on the platform account and
// aren't visible to a connected account's key. If this list is clean but Easy
// Tune still gets events, the account is connected under their Connect platform.)
async function listWebhookEndpoints(k: string): Promise<any[]> {
  const page = await stripeGet(k, '/webhook_endpoints?limit=100')
  const data: any[] = Array.isArray(page?.data) ? page.data : []
  return data.map(w => ({
    url: w.url,
    status: w.status,
    api_version: w.api_version || null,
    application: w.application || null,            // set if created by a Connect app
    description: w.description || null,
    enabled_events: Array.isArray(w.enabled_events)
      ? (w.enabled_events.length > 12 ? `${w.enabled_events.length} events` : w.enabled_events)
      : null,
  }))
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Auth: admin session OR cron secret bearer
  const cronSecret = process.env.CRON_SECRET
  const bearerOk = !!cronSecret && req.headers.authorization === `Bearer ${cronSecret}`
  if (!bearerOk) {
    const user = await getCurrentUser(req)
    if (!user || !roleHasPermission(user.role, 'admin:b2b')) {
      return res.status(401).json({ error: 'Unauthorised — admin only' })
    }
  }

  const results = await Promise.all(KEY_ENVS.map(async ({ env, role }) => {
    const k = process.env[env]
    if (!k) return { env, role, set: false }
    const mode = k.startsWith('sk_live_') || k.startsWith('rk_live_') ? 'live'
      : k.startsWith('sk_test_') || k.startsWith('rk_test_') ? 'test' : 'unknown'
    try {
      const acct = await stripeGet(k, '/account')
      // Webhook endpoints registered on this account (best-effort — restricted
      // keys may lack permission, which is fine; we just note it).
      let webhook_endpoints: any = undefined
      try { webhook_endpoints = await listWebhookEndpoints(k) }
      catch (e: any) { webhook_endpoints = { error: (e?.message || String(e)).slice(0, 200) } }
      return {
        env, role, set: true, key_preview: preview(k), mode,
        account_id: acct?.id || null,
        business_name: acct?.business_profile?.name || acct?.settings?.dashboard?.display_name || null,
        country: acct?.country || null,
        default_currency: acct?.default_currency || null,
        email: acct?.email || null,
        charges_enabled: acct?.charges_enabled ?? null,
        payouts_enabled: acct?.payouts_enabled ?? null,
        webhook_endpoints,
      }
    } catch (e: any) {
      return { env, role, set: true, key_preview: preview(k), mode, error: (e?.message || String(e)).slice(0, 300) }
    }
  }))

  return res.status(200).json({
    ok: true,
    note: 'The B2B portal charges the account shown for STRIPE_SECRET_KEY. It should be the Just Autos / JA-Portal account, NOT Easy Tune.',
    accounts: results,
  })
}

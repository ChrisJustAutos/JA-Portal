// lib/b2b-freight-carriers.ts
// Provider registry for B2B freight carriers — the credential field
// definitions, the masking rules, and the per-provider "test connection"
// probe.
//
// Adding a new carrier later: add an entry to PROVIDERS with its field
// list and a testConnection() implementation. The settings UI and the
// /api/b2b/admin/freight-carriers endpoints are provider-agnostic and
// will pick the new entry up automatically.

export type ProviderId = 'shippit' | 'starshipit' | 'auspost' | 'sendle'
export type Environment = 'live' | 'sandbox'

export interface CredentialField {
  // Key in the credentials jsonb bag.
  key: string
  // Label shown in the settings UI.
  label: string
  // Helper text under the input.
  hint?: string
  // 'secret' fields are masked on read and rendered as password inputs.
  type: 'text' | 'secret'
  required: boolean
}

export interface ProviderDef {
  id: ProviderId
  label: string
  // One-line description used on the connection card.
  blurb: string
  // Where to point the user if they don't know what to paste.
  docsUrl: string
  // Which environments are valid for this carrier.
  environments: Environment[]
  // The credential schema. Order is the form order.
  fields: CredentialField[]
  // Hits a low-impact authenticated endpoint and returns whether the
  // creds are valid. Errors are caught upstream and stored as
  // last_test_error.
  testConnection: (creds: Record<string, string>, env: Environment) => Promise<TestResult>
}

export interface TestResult {
  ok: boolean
  message: string
  detail?: Record<string, any>
}

// ─── Provider implementations ───────────────────────────────────────

// Shippit — REST API at /api/3/*. Auth: Authorization: Bearer <api_key>.
// /merchant returns the merchant profile for the authenticated key, so
// it's the canonical "is this key valid" probe.
async function testShippit(creds: Record<string, string>, env: Environment): Promise<TestResult> {
  const apiKey = creds.api_key?.trim()
  if (!apiKey) return { ok: false, message: 'API key is required' }
  const base = env === 'sandbox'
    ? 'https://api-staging.shippit.com/api/3'
    : 'https://app.shippit.com/api/3'
  const r = await fetch(`${base}/merchant`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  })
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch {}
  if (!r.ok) {
    return {
      ok: false,
      message: `Shippit replied ${r.status}: ${body?.error_description || body?.error || text.slice(0, 200) || 'no body'}`,
      detail: { status: r.status, body },
    }
  }
  const merchant = body?.response || body
  return {
    ok: true,
    message: merchant?.name ? `Connected as "${merchant.name}"` : 'Connected',
    detail: { merchant: merchant?.name, business_name: merchant?.business_name },
  }
}

// StarShipIT — REST API at /api/v1/*. Auth uses two headers:
//   StarShipIT-Api-Key  (per-account)
//   Ocp-Apim-Subscription-Key  (per-app, from the developer portal)
// /addresses/sender is a small read-only endpoint that requires both.
async function testStarShipIT(creds: Record<string, string>, _env: Environment): Promise<TestResult> {
  const apiKey = creds.api_key?.trim()
  const subKey = creds.subscription_key?.trim()
  if (!apiKey)  return { ok: false, message: 'API key is required' }
  if (!subKey)  return { ok: false, message: 'Subscription key is required' }
  const r = await fetch('https://api.starshipit.com/api/addresses/sender', {
    method: 'GET',
    headers: {
      'StarShipIT-Api-Key':         apiKey,
      'Ocp-Apim-Subscription-Key':  subKey,
      'Content-Type':               'application/json',
    },
  })
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch {}
  if (!r.ok) {
    return {
      ok: false,
      message: `StarShipIT replied ${r.status}: ${body?.message || body?.error || text.slice(0, 200) || 'no body'}`,
      detail: { status: r.status, body },
    }
  }
  const sender = body?.sender || body
  return {
    ok: true,
    message: sender?.name ? `Connected (sender: ${sender.name})` : 'Connected',
    detail: { sender_name: sender?.name, suburb: sender?.suburb, state: sender?.state },
  }
}

// Australia Post (Shipping & Tracking API). Auth: HTTP Basic
// Authorization: Basic base64(api_key:api_password). The /accounts/{id}
// endpoint returns the account profile and is cheap.
async function testAusPost(creds: Record<string, string>, env: Environment): Promise<TestResult> {
  const accountNumber = creds.account_number?.trim()
  const apiKey        = creds.api_key?.trim()
  const apiPassword   = creds.api_password?.trim()
  if (!accountNumber) return { ok: false, message: 'Account number is required' }
  if (!apiKey)        return { ok: false, message: 'API key is required' }
  if (!apiPassword)   return { ok: false, message: 'API password is required' }
  const base = env === 'sandbox'
    ? 'https://digitalapi.auspost.com.au/test/shipping/v1'
    : 'https://digitalapi.auspost.com.au/shipping/v1'
  const auth = Buffer.from(`${apiKey}:${apiPassword}`).toString('base64')
  const r = await fetch(`${base}/accounts/${encodeURIComponent(accountNumber)}`, {
    method: 'GET',
    headers: {
      'Authorization':  `Basic ${auth}`,
      'Account-Number': accountNumber,
      'Accept':         'application/json',
    },
  })
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch {}
  if (!r.ok) {
    return {
      ok: false,
      message: `Australia Post replied ${r.status}: ${body?.errors?.[0]?.message || body?.message || text.slice(0, 200) || 'no body'}`,
      detail: { status: r.status, body },
    }
  }
  const acct = body?.account || body
  return {
    ok: true,
    message: acct?.account_description ? `Connected: ${acct.account_description}` : 'Connected',
    detail: { account_description: acct?.account_description, account_state: acct?.state },
  }
}

// Sendle — REST API at api.sendle.com / sandbox.sendle.com. Auth: HTTP
// Basic with sendle_id:api_key. /api/ping returns 200 + { ping: 'pong' }
// for any valid auth pair.
async function testSendle(creds: Record<string, string>, env: Environment): Promise<TestResult> {
  const sendleId = creds.sendle_id?.trim()
  const apiKey   = creds.api_key?.trim()
  if (!sendleId) return { ok: false, message: 'Sendle ID is required' }
  if (!apiKey)   return { ok: false, message: 'API key is required' }
  const base = env === 'sandbox'
    ? 'https://sandbox.sendle.com/api'
    : 'https://api.sendle.com/api'
  const auth = Buffer.from(`${sendleId}:${apiKey}`).toString('base64')
  const r = await fetch(`${base}/ping`, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept':        'application/json',
    },
  })
  const text = await r.text()
  let body: any = null
  try { body = JSON.parse(text) } catch {}
  if (!r.ok) {
    return {
      ok: false,
      message: `Sendle replied ${r.status}: ${body?.error_description || body?.error || text.slice(0, 200) || 'no body'}`,
      detail: { status: r.status, body },
    }
  }
  return {
    ok: true,
    message: `Connected (Sendle ID ${sendleId})`,
    detail: { ping: body?.ping, timestamp: body?.timestamp },
  }
}

// ─── Registry ───────────────────────────────────────────────────────

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  shippit: {
    id: 'shippit',
    label: 'Shippit',
    blurb: 'Multi-carrier aggregator (AusPost, Couriers Please, Sendle, etc.) via a single API key.',
    docsUrl: 'https://developer.shippit.com',
    environments: ['live', 'sandbox'],
    fields: [
      { key: 'api_key', label: 'API key', hint: 'Found in Shippit → Settings → API.', type: 'secret', required: true },
    ],
    testConnection: testShippit,
  },
  starshipit: {
    id: 'starshipit',
    label: 'StarShipIT',
    blurb: 'AU/NZ shipping aggregator. Needs both an API key and a subscription key.',
    docsUrl: 'https://developers.starshipit.com',
    environments: ['live'],
    fields: [
      { key: 'api_key',          label: 'API key',          hint: 'StarShipIT → Settings → API → API Key.',                  type: 'secret', required: true },
      { key: 'subscription_key', label: 'Subscription key', hint: 'StarShipIT → Settings → API → Subscription Key.',         type: 'secret', required: true },
    ],
    testConnection: testStarShipIT,
  },
  auspost: {
    id: 'auspost',
    label: 'Australia Post',
    blurb: 'Direct AusPost (eParcel / MyPost Business) integration.',
    docsUrl: 'https://developers.auspost.com.au',
    environments: ['live', 'sandbox'],
    fields: [
      { key: 'account_number', label: 'Account number', hint: '8-digit AusPost charge account.',                       type: 'text',   required: true },
      { key: 'api_key',        label: 'API key',        hint: 'From your AusPost developer profile.',                   type: 'secret', required: true },
      { key: 'api_password',   label: 'API password',   hint: 'Paired with the API key when you provisioned access.',   type: 'secret', required: true },
    ],
    testConnection: testAusPost,
  },
  sendle: {
    id: 'sendle',
    label: 'Sendle',
    blurb: 'Sendle network only. Best for small parcels.',
    docsUrl: 'https://developers.sendle.com',
    environments: ['live', 'sandbox'],
    fields: [
      { key: 'sendle_id', label: 'Sendle ID', hint: 'Sendle dashboard → Settings → API.',  type: 'text',   required: true },
      { key: 'api_key',   label: 'API key',   hint: 'Sendle dashboard → Settings → API.',  type: 'secret', required: true },
    ],
    testConnection: testSendle,
  },
}

export const PROVIDER_ORDER: ProviderId[] = ['shippit', 'starshipit', 'auspost', 'sendle']

export function getProvider(id: string): ProviderDef | null {
  return (PROVIDERS as any)[id] || null
}

// ─── Credential masking ─────────────────────────────────────────────

// Masked representation safe to send to the browser. Secret fields are
// replaced with a fixed placeholder (with a hint of the tail so the
// admin can tell which key is in there) — text fields pass through.
export function maskCredentials(
  provider: ProviderDef,
  raw: Record<string, any> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  const r = raw || {}
  for (const f of provider.fields) {
    const v = String(r[f.key] || '')
    if (f.type === 'secret') {
      if (!v) { out[f.key] = ''; continue }
      const tail = v.length > 4 ? v.slice(-4) : ''
      out[f.key] = `••••${tail}`
    } else {
      out[f.key] = v
    }
  }
  return out
}

// When the UI sends back creds for an update, secret fields whose value
// is the masked placeholder mean "leave the existing value alone". This
// lets the admin edit, say, the Sendle ID without retyping the API key.
export function mergeCredentialUpdate(
  provider: ProviderDef,
  existing: Record<string, any> | null | undefined,
  incoming: Record<string, any> | null | undefined,
): { creds: Record<string, string>; missing: string[] } {
  const cur = existing || {}
  const inc = incoming || {}
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const f of provider.fields) {
    const incVal = inc[f.key]
    if (incVal == null || (typeof incVal === 'string' && /^•+/.test(incVal))) {
      // Untouched in the form — keep what we have.
      const curVal = String(cur[f.key] || '').trim()
      if (curVal) out[f.key] = curVal
      else if (f.required) missing.push(f.label)
    } else {
      const v = String(incVal).trim()
      if (v) out[f.key] = v
      else if (f.required) missing.push(f.label)
    }
  }
  return { creds: out, missing }
}

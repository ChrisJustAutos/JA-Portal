// lib/myob.ts
// MYOB AccountRight Live — OAuth 2.0 client and API wrapper.
//
// References:
//   https://accountrightapi.myob.com/
//   https://developer.myob.com/api/myob-business-api/api-overview/
//   https://apisupport.myob.com/hc/en-us/articles/13065472856719 (post-March 2025 changes)
//
// Architecture:
//   - OAuth tokens live in Supabase (myob_connections table), single row per
//     connection (labelled 'JAWS' / 'VPS' etc). Access tokens expire every
//     20 min; refresh tokens last ~1 year.
//   - Every authenticated request calls `getValidAccessToken(connId)` which
//     refreshes transparently if the access token is within 60s of expiring.
//   - Two CF auth modes (see myobFetch below):
//       SSO mode (post-March 2025 default): bearer token alone is sufficient,
//         no x-myobapi-cftoken header.
//       Legacy mode: file requires per-file user/password, sent as cftoken.
//   - Every API call is logged to `myob_api_log` for audit + debugging.
//
// Post-March 2025 OAuth changes:
//   - The legacy `CompanyFile` scope is deprecated for keys created after
//     12 March 2025. New keys must use SME scopes (e.g. `sme-company-file`,
//     `sme-sales`, `sme-customer`).
//   - The legacy `GET /accountright/` endpoint no longer returns company
//     file lists for new keys. Instead, the businessId of the chosen file
//     is returned on the OAuth redirect — provided `prompt=consent` is set
//     in the authorise URL.
//   - `prompt=consent` also forces MYOB to show the file picker, so the
//     user picks WHICH company file this OAuth flow is for. Each company
//     file = one OAuth flow.
//   - SSO mode is the default for new keys: x-myobapi-cftoken is NOT
//     required when the user authenticated via OAuth.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

// ── Env ─────────────────────────────────────────────────────────────────
function clientId()     { const v = process.env.MYOB_CLIENT_ID;     if (!v) throw new Error('MYOB_CLIENT_ID not set');     return v }
function clientSecret() { const v = process.env.MYOB_CLIENT_SECRET; if (!v) throw new Error('MYOB_CLIENT_SECRET not set'); return v }
function redirectUri()  { const v = process.env.MYOB_REDIRECT_URI;  if (!v) throw new Error('MYOB_REDIRECT_URI not set');  return v }

// ── Supabase (service-role) ─────────────────────────────────────────────
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── MYOB endpoints ──────────────────────────────────────────────────────
const AUTH_URL  = 'https://secure.myob.com/oauth2/account/authorize'
const TOKEN_URL = 'https://secure.myob.com/oauth2/v1/authorize'
const API_BASE  = 'https://api.myob.com'

// Scope for MYOB OAuth. Behaviour:
//   - If MYOB_SCOPE env var is set, use that (e.g. 'sme-company-file sme-sales')
//   - Otherwise omit the scope parameter entirely — MYOB will grant whatever
//     the registered app is entitled to by default.
//
// Post-March 2025: keys registered after 12 March 2025 must use new SME
// scopes (`sme-company-file`, `sme-sales`, etc) — `CompanyFile` no longer
// works for those keys. Pre-March 2025 keys must continue to use `CompanyFile`.
function getScope(): string | null {
  const v = process.env.MYOB_SCOPE
  if (v === undefined) return null  // omit from URL
  if (v === '') return null         // empty means omit
  return v
}

// ── Types ───────────────────────────────────────────────────────────────
export interface MyobConnection {
  id: string
  label: string
  access_token: string
  refresh_token: string
  access_expires_at: string
  company_file_id: string | null
  company_file_uri: string | null
  company_file_name: string | null
  company_file_username: string | null
  company_file_password: string | null
  connected_at: string
  last_refreshed_at: string | null
  last_used_at: string | null
  is_active: boolean
}

export interface CompanyFile {
  Id: string
  Name: string
  LibraryPath: string
  Uri: string
  ProductVersion: string
  ProductLevel?: { Code: number; Name: string }
  Country?: string
}

// ── OAuth helpers ───────────────────────────────────────────────────────

// Build the authorise URL the browser redirects to. `state` is a random
// CSRF value that connect.ts persists to Supabase (see myob_oauth_state
// table) and callback.ts looks up after MYOB redirects back.
//
// `prompt=consent` is REQUIRED for keys created after 12 March 2025:
//   1. Forces the company-file picker on the consent screen so the user
//      explicitly picks which file this OAuth flow represents.
//   2. Causes MYOB to return `businessId` (the company file GUID) on the
//      callback URL, which we capture and persist alongside the tokens.
//      Without `prompt=consent`, no businessId is returned.
//
// Scope is included only if configured (see getScope()). For pre-March 2025
// keys, set MYOB_SCOPE=CompanyFile. For post-March 2025 keys, use space-
// separated SME scopes (e.g. `MYOB_SCOPE=sme-company-file sme-sales`).
export function buildAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    state,
    prompt: 'consent',
  })
  const scope = getScope()
  if (scope) p.append('scope', scope)
  return `${AUTH_URL}?${p.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number              // seconds (typically 1200 = 20 min)
  scope: string
  token_type: string              // "bearer"
  user: { uid: string; username: string }
}

// Exchange the authorisation code from the callback for tokens.
// MYOB requires x-www-form-urlencoded body, not JSON. Scope is omitted here
// — the authorise step already established what scopes the user granted, and
// the token endpoint doesn't require scope to be re-sent.
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`MYOB token exchange failed (${res.status}): ${text.substring(0, 400)}`)
  }
  try { return JSON.parse(text) } catch {
    throw new Error(`MYOB token exchange returned non-JSON: ${text.substring(0, 200)}`)
  }
}

async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`MYOB refresh failed (${res.status}): ${text.substring(0, 400)}`)
  try { return JSON.parse(text) } catch {
    throw new Error(`MYOB refresh returned non-JSON: ${text.substring(0, 200)}`)
  }
}

// Save or update a connection's tokens (upsert by label).
//
// `businessId` is the company file GUID returned on the OAuth redirect for
// post-March 2025 keys. When provided, we persist it as company_file_id so
// subsequent API calls can scope to /accountright/{businessId}/... without
// needing a separate "list company files + pick one" step.
export async function saveConnection(
  label: string,
  tokens: TokenResponse,
  connectedBy: string | null,
  businessId?: string | null,
): Promise<MyobConnection> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const update: Record<string, any> = {
    label,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_expires_at: expiresAt,
    connected_by: connectedBy,
    last_refreshed_at: new Date().toISOString(),
    is_active: true,
  }
  if (businessId) update.company_file_id = businessId
  const { data, error } = await sb()
    .from('myob_connections')
    .upsert(update, { onConflict: 'label' })
    .select()
    .single()
  if (error) throw new Error('Failed to save MYOB connection: ' + error.message)
  return data as MyobConnection
}

// Load a single connection by label. Returns null if not found/inactive.
export async function getConnection(label: string): Promise<MyobConnection | null> {
  const { data, error } = await sb()
    .from('myob_connections')
    .select('*')
    .eq('label', label)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error('Failed to load MYOB connection: ' + error.message)
  return (data || null) as MyobConnection | null
}

export async function listConnections(): Promise<MyobConnection[]> {
  const { data, error } = await sb()
    .from('myob_connections')
    .select('*')
    .order('connected_at', { ascending: false })
  if (error) throw new Error('Failed to list MYOB connections: ' + error.message)
  return (data || []) as MyobConnection[]
}

// Get a valid access token — refresh if within 60s of expiring.
export async function getValidAccessToken(connId: string): Promise<string> {
  const { data, error } = await sb()
    .from('myob_connections')
    .select('*')
    .eq('id', connId)
    .single()
  if (error || !data) throw new Error('MYOB connection not found')
  const conn = data as MyobConnection

  const expiresMs = new Date(conn.access_expires_at).getTime()
  const now = Date.now()
  // Refresh if we're within 60s of expiry
  if (expiresMs - now > 60_000) return conn.access_token

  const fresh = await refreshTokens(conn.refresh_token)
  const expiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString()
  await sb().from('myob_connections').update({
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    access_expires_at: expiresAt,
    last_refreshed_at: new Date().toISOString(),
  }).eq('id', connId)
  return fresh.access_token
}

// ── Logging ─────────────────────────────────────────────────────────────
async function logApiCall(entry: {
  connectionId?: string
  method: string
  path: string
  status?: number
  durationMs?: number
  error?: string
  requestBody?: string
  response?: string
  performedBy?: string | null
}): Promise<void> {
  try {
    const bodyHash = entry.requestBody
      ? createHash('sha256').update(entry.requestBody).digest('hex')
      : null
    await sb().from('myob_api_log').insert({
      connection_id: entry.connectionId || null,
      method: entry.method,
      path: entry.path,
      status: entry.status || null,
      duration_ms: entry.durationMs || null,
      error: entry.error || null,
      request_body_hash: bodyHash,
      response_snippet: entry.response ? entry.response.substring(0, 500) : null,
      performed_by: entry.performedBy || null,
    })
  } catch (e: any) {
    // Logging failure mustn't break the main flow — just console it.
    console.error('myob: failed to log API call:', e?.message)
  }
}

// ── Authenticated fetch ─────────────────────────────────────────────────
// Handles:
//  - OAuth bearer token (auto-refreshed)
//  - CompanyFile auth header (mode-dependent — see below)
//  - MYOB-specific required headers (`x-myobapi-key`, `x-myobapi-version`)
//  - Audit logging
//
// CF auth modes:
//   SSO mode (post-March 2025 default): the OAuth token alone is sufficient,
//     no x-myobapi-cftoken header is sent. This is the case when the
//     connection's company_file_username is null/undefined — i.e. the user
//     authenticated via OAuth and we trust that as proof of identity.
//   Legacy mode: file has per-file user/password set. We send
//     base64(username:password) in x-myobapi-cftoken. This is the case when
//     company_file_username is set on the row.
//   `requiresCfAuth: false` overrides both — used for the /accountright/
//     listing endpoint which has no file context. Defaults to true.
export async function myobFetch(
  connId: string,
  path: string,                    // e.g. '/accountright/{id}/Sale/Invoice'
  opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: any
    query?: Record<string, string | number | boolean | undefined>
    performedBy?: string | null
    requiresCfAuth?: boolean
  } = {},
): Promise<{ status: number; data: any; raw: string }> {
  const method = opts.method || 'GET'
  const performedBy = opts.performedBy || null
  const requiresCfAuth = opts.requiresCfAuth !== false  // default true

  // Build URL with query params
  let url = API_BASE + path
  if (opts.query) {
    const qp = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) qp.append(k, String(v))
    }
    const qs = qp.toString()
    if (qs) url += (path.includes('?') ? '&' : '?') + qs
  }

  // Get connection for CF credentials
  const { data: connData, error: connErr } = await sb()
    .from('myob_connections')
    .select('*')
    .eq('id', connId)
    .single()
  if (connErr || !connData) throw new Error('MYOB connection not found for fetch')
  const conn = connData as MyobConnection

  // Refresh token if needed
  const accessToken = await getValidAccessToken(connId)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'x-myobapi-key': clientId(),
    'x-myobapi-version': 'v2',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip,deflate',
  }
  if (opts.body) headers['Content-Type'] = 'application/json'

  // Company File auth header — see "CF auth modes" docblock above.
  // SSO mode (no username on connection) → no cftoken header sent.
  // Legacy mode (username set) → base64(user:pass) cftoken header.
  if (requiresCfAuth) {
    const hasCfCreds = conn.company_file_username !== null
                    && conn.company_file_username !== undefined
    if (hasCfCreds) {
      const user = conn.company_file_username || 'Administrator'
      const pw = conn.company_file_password || ''
      const b64 = Buffer.from(`${user}:${pw}`, 'utf-8').toString('base64')
      headers['x-myobapi-cftoken'] = b64
    }
    // else: SSO mode — bearer token alone is sufficient, MYOB recognises the
    // OAuth user as the file user. No cftoken sent.
  }

  const startMs = Date.now()
  const requestBody = opts.body ? JSON.stringify(opts.body) : undefined
  let status = 0
  let raw = ''
  let data: any = null
  let errMsg: string | undefined

  try {
    const res = await fetch(url, { method, headers, body: requestBody })
    status = res.status
    raw = await res.text()
    if (raw) {
      try { data = JSON.parse(raw) } catch { data = raw }
    }
    if (!res.ok) {
      errMsg = typeof data === 'object' && data?.Errors?.[0]?.Message
        ? data.Errors[0].Message
        : (typeof data === 'string' ? data.substring(0, 200) : `HTTP ${status}`)
    }
  } catch (e: any) {
    errMsg = e?.message || String(e)
    throw e
  } finally {
    const durationMs = Date.now() - startMs
    logApiCall({
      connectionId: connId,
      method, path,
      status, durationMs,
      error: errMsg,
      requestBody,
      response: raw,
      performedBy,
    })
    // Update last_used_at on the connection
    sb().from('myob_connections').update({ last_used_at: new Date().toISOString() }).eq('id', connId)
      .then(() => {}, () => {})
  }

  return { status, data, raw }
}

// ── Company file helpers ────────────────────────────────────────────────

// List all company files the user has access to (called right after OAuth to
// let the user pick which CF this connection represents).
//
// NOTE (post-March 2025): for keys created after 12 March 2025, the legacy
// `GET /accountright/` endpoint is deprecated and returns 401. For those
// keys, the businessId is captured directly from the OAuth redirect and
// stored on the connection — there's no "list" step. This function remains
// for legacy keys that still use the old flow.
export async function listCompanyFiles(connId: string): Promise<CompanyFile[]> {
  const { data, status } = await myobFetch(connId, '/accountright', { requiresCfAuth: false })
  if (status !== 200) throw new Error(`listCompanyFiles failed: HTTP ${status}`)
  return Array.isArray(data) ? data : []
}

export async function saveCompanyFile(
  connId: string,
  cf: CompanyFile,
  cfUsername: string,
  cfPassword: string,
): Promise<void> {
  const { error } = await sb().from('myob_connections').update({
    company_file_id: cf.Id,
    company_file_uri: cf.Uri,
    company_file_name: cf.Name,
    company_file_username: cfUsername,
    company_file_password: cfPassword,
  }).eq('id', connId)
  if (error) throw new Error('Failed to save company file: ' + error.message)
}

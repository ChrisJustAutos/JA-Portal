// lib/myob.ts
// MYOB AccountRight Live — OAuth 2.0 client and API wrapper.
//
// References:
//   https://accountrightapi.myob.com/
//   https://developer.myob.com/api/myob-business-api/api-overview/
//
// Architecture:
//   - OAuth tokens live in Supabase (myob_connections table), single row per
//     connection (labelled 'JAWS' / 'VPS' etc). Access tokens expire every
//     20 min; refresh tokens last ~1 year.
//   - Every authenticated request calls `getValidAccessToken(connId)` which
//     refreshes transparently if the access token is within 60s of expiring.
//   - Requests need a Company File (CF) context: we send `x-myobapi-cftoken`
//     (CF-level basic auth) plus the bearer token for the OAuth user.
//   - Every API call is logged to `myob_api_log` for audit + debugging.

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

// Scope for AccountRight API — `CompanyFile` is required for all CF-scoped ops
const SCOPE = 'CompanyFile'

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
// CSRF value we stash in a short-lived cookie and verify on callback.
export function buildAuthorizeUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
  })
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
// MYOB requires x-www-form-urlencoded body, not JSON.
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    scope: SCOPE,
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
export async function saveConnection(
  label: string,
  tokens: TokenResponse,
  connectedBy: string | null,
): Promise<MyobConnection> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const { data, error } = await sb()
    .from('myob_connections')
    .upsert({
      label,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_expires_at: expiresAt,
      connected_by: connectedBy,
      last_refreshed_at: new Date().toISOString(),
      is_active: true,
    }, { onConflict: 'label' })
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
//  - CompanyFile basic-auth header if the connection has CF credentials saved
//  - MYOB-specific required headers (`x-myobapi-key`, `x-myobapi-version`)
//  - Audit logging
export async function myobFetch(
  connId: string,
  path: string,                    // e.g. '/accountright/{id}/Sale/Invoice'
  opts: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: any
    query?: Record<string, string | number | boolean | undefined>
    performedBy?: string | null
    requiresCfAuth?: boolean        // true for CF-scoped endpoints; false for /accountright (CF list)
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

  // CF-level basic auth — MYOB requires this for any request *within* a
  // company file. Format: base64(username:password). Blank password for
  // files with no password is "Username:" (trailing colon, empty pw).
  if (requiresCfAuth) {
    if (!conn.company_file_username && conn.company_file_username !== '') {
      throw new Error('Company file not selected or CF credentials missing')
    }
    const user = conn.company_file_username || 'Administrator'
    const pw = conn.company_file_password || ''
    const b64 = Buffer.from(`${user}:${pw}`, 'utf-8').toString('base64')
    headers['x-myobapi-cftoken'] = b64
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

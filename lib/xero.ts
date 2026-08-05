// lib/xero.ts
//
// Xero connection layer — the Xero counterpart of lib/myob.ts.
//
// One Xero app (XERO_CLIENT_ID/SECRET via integration settings or env); each
// entity label (VPS/JAWS) maps to one Xero organisation (tenant) in
// xero_connections. A single OAuth consent can authorise both orgs — the
// callback lists tenants and they're assigned to labels afterwards.
//
// GOTCHAS baked in:
//  • Xero refresh tokens are SINGLE-USE and rotate — the new refresh_token
//    MUST be persisted after every refresh or the connection dies. Refresh
//    is serialised per-connection within this process for that reason.
//  • Rate limits: 60 calls/min + 5000/day per tenant. 429s carry Retry-After;
//    xeroFetch retries once.
//  • API calls need BOTH the bearer token AND the Xero-tenant-id header.

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getIntegrations } from './integration-config'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

export type XeroLabel = 'VPS' | 'JAWS'

export interface XeroConnection {
  id: string
  label: string
  tenant_id: string | null
  tenant_name: string | null
  access_token: string | null
  refresh_token: string | null
  access_expires_at: string | null
  is_active: boolean
}

const AUTH_BASE = 'https://login.xero.com/identity/connect/authorize'
const TOKEN_URL = 'https://identity.xero.com/connect/token'
const CONNECTIONS_URL = 'https://api.xero.com/connections'
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

// Everything the portal will eventually need. offline_access is what makes
// refresh tokens exist at all.
export const XERO_SCOPES = [
  'offline_access', 'accounting.transactions', 'accounting.contacts',
  'accounting.settings', 'accounting.attachments', 'accounting.reports.read',
].join(' ')

async function creds(): Promise<{ id: string; secret: string; redirect: string }> {
  const cfg = await getIntegrations(['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI'])
  const redirect = cfg.XERO_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'https://justautos.app'}/api/xero/auth/callback`
  if (!cfg.XERO_CLIENT_ID || !cfg.XERO_CLIENT_SECRET) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured (Settings → Connections → Integrations)')
  return { id: cfg.XERO_CLIENT_ID, secret: cfg.XERO_CLIENT_SECRET, redirect }
}

export async function xeroAuthorizeUrl(state: string): Promise<string> {
  const c = await creds()
  const q = new URLSearchParams({
    response_type: 'code', client_id: c.id, redirect_uri: c.redirect,
    scope: XERO_SCOPES, state,
  })
  return `${AUTH_BASE}?${q.toString()}`
}

async function tokenRequest(body: URLSearchParams): Promise<any> {
  const c = await creds()
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Xero token endpoint ${r.status}: ${j.error || JSON.stringify(j).slice(0, 200)}`)
  return j
}

export async function exchangeAuthCode(code: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const c = await creds()
  return tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: c.redirect }))
}

// Tenants (organisations) the given access token can reach.
export async function listTenants(accessToken: string): Promise<{ tenantId: string; tenantName: string }[]> {
  const r = await fetch(CONNECTIONS_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) throw new Error(`Xero connections ${r.status}`)
  const arr = await r.json()
  return (arr || []).map((t: any) => ({ tenantId: t.tenantId, tenantName: t.tenantName }))
}

export async function getXeroConnection(label: XeroLabel): Promise<XeroConnection | null> {
  const { data } = await sb().from('xero_connections')
    .select('*').eq('label', label).eq('is_active', true).maybeSingle()
  return (data as XeroConnection) || null
}

// Refresh serialisation: Xero refresh tokens are single-use. Two concurrent
// crons refreshing the same connection would kill it — serialise per label
// within this process (cross-process races are still possible but rare on
// Vercel's per-function isolation; the loser gets invalid_grant and the next
// run recovers via the winner's persisted token).
const _refreshLocks = new Map<string, Promise<string>>()

export async function getValidXeroToken(label: XeroLabel): Promise<{ token: string; tenantId: string }> {
  const conn = await getXeroConnection(label)
  if (!conn || !conn.refresh_token) throw new Error(`Xero not connected for ${label}`)
  if (!conn.tenant_id) throw new Error(`Xero connected but no organisation assigned to ${label}`)
  const fresh = conn.access_expires_at && new Date(conn.access_expires_at).getTime() - Date.now() > 60_000
  if (fresh && conn.access_token) return { token: conn.access_token, tenantId: conn.tenant_id }

  let lock = _refreshLocks.get(conn.label)
  if (!lock) {
    lock = (async () => {
      const j = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token! }))
      await sb().from('xero_connections').update({
        access_token: j.access_token,
        refresh_token: j.refresh_token,   // ROTATED — must persist
        access_expires_at: new Date(Date.now() + (j.expires_in || 1800) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', conn.id)
      return j.access_token as string
    })()
    _refreshLocks.set(conn.label, lock)
    lock.finally(() => _refreshLocks.delete(conn.label))
  }
  const token = await lock
  return { token, tenantId: conn.tenant_id }
}

// The Xero counterpart of myobFetch. path is relative to api.xro/2.0
// (e.g. '/Invoices?where=...'). Logs every call like myob_api_log does.
export async function xeroFetch<T = any>(label: XeroLabel, path: string, init: RequestInit = {}): Promise<T> {
  const started = Date.now()
  let status = 0
  let errMsg: string | null = null
  try {
    const { token, tenantId } = await getValidXeroToken(label)
    const doFetch = () => fetch(`${XERO_API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Xero-tenant-id': tenantId,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    })
    let r = await doFetch()
    if (r.status === 429) {
      const wait = Math.min(Number(r.headers.get('Retry-After') || 2), 30)
      await new Promise(res => setTimeout(res, wait * 1000))
      r = await doFetch()
    }
    status = r.status
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      errMsg = body.slice(0, 300)
      throw new Error(`Xero ${init.method || 'GET'} ${path} → ${r.status}: ${errMsg}`)
    }
    return await r.json() as T
  } catch (e: any) {
    errMsg = errMsg || String(e?.message || e).slice(0, 300)
    throw e
  } finally {
    try {
      await sb().from('xero_api_log').insert({
        connection_label: label, method: init.method || 'GET',
        path: path.slice(0, 300), status, duration_ms: Date.now() - started, error: errMsg,
      })
    } catch { /* logging is best-effort */ }
  }
}

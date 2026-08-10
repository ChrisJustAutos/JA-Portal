// lib/b2bAuthServer.ts
//
// Server-side auth helpers for the distributor (B2B) portal.
// Mirrors lib/authServer.ts but:
//   - Uses cookie 'ja-b2b-access-token' (separate from staff session)
//   - Looks up the user in b2b_distributor_users + b2b_distributors
//     (instead of user_profiles)
//   - Returns a B2BUser with their distributor attached
//
// Auth flow:
//   1. User clicks magic link → lands on /b2b/auth/callback
//   2. Supabase JS SDK auto-creates a session in localStorage
//   3. Callback page POSTs the access_token to /api/b2b/auth/session
//   4. Session endpoint sets the httpOnly cookie used by these helpers
//   5. Subsequent SSR requests verify against the cookie

import type { NextApiRequest, NextApiResponse, GetServerSidePropsContext } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

export const B2B_ACCESS_COOKIE  = 'ja-b2b-access-token'
export const B2B_REFRESH_COOKIE = 'ja-b2b-refresh-token'

let _serviceClient: SupabaseClient | null = null
export function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _serviceClient = createClient(url, key, { auth: { persistSession: false } })
  return _serviceClient
}

export interface B2BDistributor {
  id: string
  displayName: string
  myobPrimaryCustomerUid: string
  myobPrimaryCustomerDisplayId: string | null
  myobLinkedCustomerUids: string[]
  distGroupId: number | null
  isActive: boolean
  // Admin-set kill-switch: false = browse-only (catalogue/cart usable,
  // order placement blocked in /api/b2b/checkout/start + cart UI).
  checkoutEnabled: boolean
}

// One person can belong to several distributor accounts (multi-site owners,
// e.g. Hunter Mechanical). memberships lists them all; distributor is the
// currently-selected one (via the ja-b2b-dist cookie, else the oldest row).
export interface B2BMembership {
  distributorId: string
  displayName: string
  role: 'owner' | 'member'
}

export interface B2BUser {
  id: string                  // b2b_distributor_users.id
  authUserId: string          // auth.users.id
  email: string
  fullName: string | null
  role: 'owner' | 'member'
  isActive: boolean
  distributor: B2BDistributor
  memberships?: B2BMembership[]
  // Read-only preview session (admin "Preview portal" / Scribe link). When
  // true, withB2BAuth blocks every non-GET request — the portal can be
  // browsed and screenshotted but nothing can be created or changed.
  preview?: boolean
}

export const B2B_PREVIEW_COOKIE = 'ja-b2b-preview'

// Selected-distributor cookie for multi-account users (set by
// /api/b2b/session/switch; ignored unless it matches a live membership).
export const B2B_DIST_COOKIE = 'ja-b2b-dist'

// Marker email for the auth-less "Portal Preview" user seeded per distributor
// so a demo session can own a real cart (b2b_carts FKs b2b_distributor_users).
export const PREVIEW_USER_EMAIL = (distributorId: string) => `preview+${distributorId}@justautos.app`

// Ensure the per-distributor preview user exists; returns its id. Called when
// an admin mints a preview link (NOT in the hot auth path). auth_user_id stays
// null (it's not a real login), is_active true so lookups pass.
export async function ensurePreviewUser(distributorId: string): Promise<string | null> {
  const sb = getServiceClient()
  const email = PREVIEW_USER_EMAIL(distributorId)
  const { data: existing } = await sb.from('b2b_distributor_users').select('id').eq('email', email).maybeSingle()
  if (existing?.id) return existing.id
  const { data: created, error } = await sb.from('b2b_distributor_users')
    .insert({ distributor_id: distributorId, email, full_name: 'Portal Preview', role: 'member', is_active: true })
    .select('id').single()
  if (error) { console.error('ensurePreviewUser failed:', error.message); return null }
  return created.id
}

// Build a read-only-ish B2BUser for a distributor from a signed preview token
// (order-action-token scope 'b2b_preview', payload = distributor id). Uses the
// seeded preview user's real id so the cart works; withB2BAuth still blocks the
// final commit endpoints (place order, tune-job submit) in preview mode.
export async function getPreviewB2BUser(req: NextApiRequest | { headers: Record<string, any> }): Promise<B2BUser | null> {
  const token = parseCookies((req.headers as any).cookie)[B2B_PREVIEW_COOKIE]
  if (!token) return null
  const { verifyOrderAction } = await import('./order-action-token')
  const v = verifyOrderAction(token, 'b2b_preview' as any)
  if (!v) return null
  const sb = getServiceClient()
  const { data: d } = await sb
    .from('b2b_distributors')
    .select('id, display_name, myob_primary_customer_uid, myob_primary_customer_display_id, myob_linked_customer_uids, dist_group_id, is_active, checkout_enabled')
    .eq('id', v.orderId).maybeSingle()
  if (!d) return null
  // Preview user id (seeded at link generation); fall back to synthetic if
  // somehow missing (nav still works, cart writes would fail gracefully).
  const { data: pu } = await sb.from('b2b_distributor_users').select('id').eq('email', PREVIEW_USER_EMAIL(d.id)).maybeSingle()
  return {
    id: pu?.id || 'preview', authUserId: 'preview', email: 'preview@justautos.app',
    fullName: 'Portal Preview', role: 'member', isActive: true, preview: true,
    distributor: {
      id: d.id, displayName: d.display_name,
      myobPrimaryCustomerUid: d.myob_primary_customer_uid,
      myobPrimaryCustomerDisplayId: d.myob_primary_customer_display_id,
      myobLinkedCustomerUids: d.myob_linked_customer_uids || [],
      distGroupId: d.dist_group_id, isActive: d.is_active,
      checkoutEnabled: d.checkout_enabled !== false,
    },
  }
}

// ── Cookie / header parsing ─────────────────────────────────────────────
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  const out: Record<string, string> = {}
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=')
    if (idx > 0) {
      const k = pair.slice(0, idx).trim()
      const v = pair.slice(idx + 1).trim()
      out[k] = decodeURIComponent(v)
    }
  }
  return out
}

function getToken(req: NextApiRequest | { headers: Record<string, any> }): string | null {
  const auth = (req.headers.authorization || (req.headers as any).Authorization) as string | undefined
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7)
  const cookies = parseCookies((req.headers as any).cookie)
  return cookies[B2B_ACCESS_COOKIE] || null
}

// ── Server-side MFA (AAL2) enforcement ─────────────────────────────────
// The login page's TOTP gate is browser code — an attacker with a phished
// password can call Supabase signInWithPassword directly and present the
// resulting AAL1 token here. Rule: a user with a verified authenticator must
// present an AAL2 token, UNLESS the request carries a valid trusted-device
// cookie (the "skip the code for 24h" feature mints AAL1 sessions by design).
const MFA_DEVICE_COOKIE = 'ja-b2b-mfa-device'
const _totpCache = new Map<string, { has: boolean; at: number }>()

export function b2bTokenAal(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    return payload?.aal ? String(payload.aal) : null
  } catch { return null }
}

export async function b2bHasVerifiedTotp(authUserId: string): Promise<boolean> {
  const hit = _totpCache.get(authUserId)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.has
  let has = false
  try {
    const { data, error } = await (getServiceClient().auth.admin as any).mfa.listFactors({ userId: authUserId })
    if (!error) has = ((data as any)?.factors || []).some((f: any) => f?.status === 'verified')
    else console.error('mfa listFactors error (treating as no factors):', error?.message)
  } catch (e: any) { console.error('mfa listFactors failed (treating as no factors):', e?.message) }
  _totpCache.set(authUserId, { has, at: Date.now() })
  return has
}

export async function b2bMfaSatisfied(
  req: { headers: Record<string, any> } | null,
  token: string,
  authUserId: string,
): Promise<boolean> {
  if (b2bTokenAal(token) === 'aal2') return true
  if (!(await b2bHasVerifiedTotp(authUserId))) return true  // 2FA not enrolled
  if (!req) return false
  const deviceToken = parseCookies((req.headers as any).cookie)[MFA_DEVICE_COOKIE]
  if (!deviceToken) return false
  const hash = createHash('sha256').update(deviceToken).digest('hex')
  const { data } = await getServiceClient().from('mfa_trusted_devices')
    .select('id').eq('user_id', authUserId).eq('token_hash', hash)
    .gt('expires_at', new Date().toISOString()).maybeSingle()
  return !!data
}

// ── Core lookup ────────────────────────────────────────────────────────
export async function getCurrentB2BUser(req: NextApiRequest | { headers: Record<string, any> }): Promise<B2BUser | null> {
  const token = getToken(req)
  if (!token) {
    // No real session — fall back to a read-only preview session if present.
    return getPreviewB2BUser(req)
  }
  const preferred = parseCookies((req.headers as any).cookie)[B2B_DIST_COOKIE] || null
  const user = await getCurrentB2BUserFromToken(token, preferred)
  if (!user) return null
  if (!(await b2bMfaSatisfied(req, token, user.authUserId))) return null
  return user
}

export async function getCurrentB2BUserFromToken(token: string, preferredDistributorId?: string | null): Promise<B2BUser | null> {
  const sb = getServiceClient()
  const { data: authData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !authData?.user) return null

  // One row per distributor membership — multi-site owners have several.
  const { data: rows, error: rowErr } = await sb
    .from('b2b_distributor_users')
    .select(`
      id, auth_user_id, email, full_name, role, is_active, created_at,
      distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey (
        id, display_name,
        myob_primary_customer_uid, myob_primary_customer_display_id,
        myob_linked_customer_uids, dist_group_id, is_active, checkout_enabled
      )
    `)
    .eq('auth_user_id', authData.user.id)
    .order('created_at', { ascending: true })

  if (rowErr) {
    console.error('getCurrentB2BUser lookup error:', rowErr)
    return null
  }

  // Live memberships only: active user row + active distributor.
  const live = (rows || [])
    .map((r: any) => ({ row: r, dist: Array.isArray(r.distributor) ? r.distributor[0] : r.distributor }))
    .filter(({ row, dist }) => row.is_active !== false && dist && dist.is_active !== false)
  if (live.length === 0) return null

  const picked = live.find(({ dist }) => preferredDistributorId && dist.id === preferredDistributorId) || live[0]
  const row = picked.row
  const distRaw = picked.dist

  return {
    id: row.id,
    authUserId: row.auth_user_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    distributor: {
      id: distRaw.id,
      displayName: distRaw.display_name,
      myobPrimaryCustomerUid: distRaw.myob_primary_customer_uid,
      myobPrimaryCustomerDisplayId: distRaw.myob_primary_customer_display_id,
      myobLinkedCustomerUids: distRaw.myob_linked_customer_uids || [],
      distGroupId: distRaw.dist_group_id,
      isActive: distRaw.is_active,
      checkoutEnabled: distRaw.checkout_enabled !== false,
    },
    memberships: live.map(({ row: r, dist: d }) => ({
      distributorId: d.id,
      displayName: d.display_name,
      role: r.role as 'owner' | 'member',
    })),
  }
}

// ── Page-level guard for getServerSideProps ────────────────────────────
export async function requireB2BPageAuth(context: GetServerSidePropsContext) {
  const b2bUser = await getCurrentB2BUser(context.req as any)
  if (!b2bUser) {
    // Carry the intended page so the login page's silent resume (or a real
    // sign-in) lands back where the user was heading.
    const next = typeof context.resolvedUrl === 'string' && context.resolvedUrl.startsWith('/b2b')
      ? `?next=${encodeURIComponent(context.resolvedUrl)}` : ''
    return {
      redirect: { destination: `/b2b/login${next}`, permanent: false },
    }
  }
  return {
    props: {
      b2bUser: {
        id: b2bUser.id,
        email: b2bUser.email,
        fullName: b2bUser.fullName,
        role: b2bUser.role,
        distributor: b2bUser.distributor,
        memberships: b2bUser.memberships || null,
        preview: b2bUser.preview || false,
      },
    },
  }
}

// ── API-route guard ────────────────────────────────────────────────────
export function withB2BAuth<T = any>(
  handler: (req: NextApiRequest, res: NextApiResponse, user: B2BUser) => Promise<T> | T,
) {
  return async function (req: NextApiRequest, res: NextApiResponse): Promise<void> {
    const user = await getCurrentB2BUser(req)
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    // Preview / "view as distributor" (Scribe demo): the purchasing WALK-
    // THROUGH works — cart add/update/remove and freight quoting are allowed
    // so the whole flow is demonstrable — but the final commits that create
    // real records or fire externally are blocked: placing the order, tune-job
    // submit, quote requests, team/account changes. So a demo can reach the
    // checkout page and everything up to it, but never actually transacts.
    if (user.preview && req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const path = String(req.url || '')
      const demoAllowed = /\/api\/b2b\/(cart|freight-quote)/.test(path)
      if (!demoAllowed) {
        res.status(403).json({ error: 'Demo mode — this is the last step and it’s disabled in the preview, so nothing real is created.' })
        return
      }
    }
    try {
      await handler(req, res, user)
    } catch (e: any) {
      console.error('withB2BAuth handler threw:', e)
      if (!res.writableEnded) {
        res.status(500).json({ error: e?.message || 'Internal error' })
      }
    }
  }
}

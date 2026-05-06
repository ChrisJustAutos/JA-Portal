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

export const B2B_ACCESS_COOKIE  = 'ja-b2b-access-token'
export const B2B_REFRESH_COOKIE = 'ja-b2b-refresh-token'

let _serviceClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient {
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
}

export interface B2BUser {
  id: string                  // b2b_distributor_users.id
  authUserId: string          // auth.users.id
  email: string
  fullName: string | null
  role: 'owner' | 'member'
  isActive: boolean
  distributor: B2BDistributor
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

// ── Core lookup ────────────────────────────────────────────────────────
export async function getCurrentB2BUser(req: NextApiRequest | { headers: Record<string, any> }): Promise<B2BUser | null> {
  const token = getToken(req)
  if (!token) return null
  return getCurrentB2BUserFromToken(token)
}

export async function getCurrentB2BUserFromToken(token: string): Promise<B2BUser | null> {
  const sb = getServiceClient()
  const { data: authData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !authData?.user) return null

  const { data: row, error: rowErr } = await sb
    .from('b2b_distributor_users')
    .select(`
      id, auth_user_id, email, full_name, role, is_active,
      distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey (
        id, display_name,
        myob_primary_customer_uid, myob_primary_customer_display_id,
        myob_linked_customer_uids, dist_group_id, is_active
      )
    `)
    .eq('auth_user_id', authData.user.id)
    .maybeSingle()

  if (rowErr) {
    console.error('getCurrentB2BUser lookup error:', rowErr)
    return null
  }
  if (!row) return null
  if (row.is_active === false) return null

  // Supabase types this as an array because of the implicit-many relationship
  // direction; in practice the FK guarantees at most one. Normalise.
  const distRaw: any = Array.isArray(row.distributor) ? row.distributor[0] : row.distributor
  if (!distRaw || distRaw.is_active === false) return null

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
    },
  }
}

// ── Page-level guard for getServerSideProps ────────────────────────────
export async function requireB2BPageAuth(context: GetServerSidePropsContext) {
  const b2bUser = await getCurrentB2BUser(context.req as any)
  if (!b2bUser) {
    return {
      redirect: { destination: '/b2b/login', permanent: false },
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

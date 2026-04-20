// lib/authServer.ts
// Server-side auth — verifies a Supabase JWT from the Authorization header or
// cookie, loads the user's profile and role from user_profiles, and exposes a
// helper to gate API routes by permission.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Permission, roleHasPermission, UserRole } from './permissions'

// Service-role client — bypasses RLS. Only use from server-side code.
let _serviceClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service env vars missing')
  _serviceClient = createClient(url, key, { auth: { persistSession: false } })
  return _serviceClient
}

export interface PortalUser {
  id: string
  email: string
  displayName: string | null
  role: UserRole
  isActive: boolean
}

// Extract the JWT from either the Authorization header or our session cookie.
function getToken(req: NextApiRequest): string | null {
  const authHeader = req.headers.authorization || ''
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim()
  // Fallback: httpOnly cookie set by /api/auth/session on login
  const cookieToken = req.cookies['ja-portal-access-token']
  if (cookieToken) return cookieToken
  return null
}

// Verify the JWT by asking Supabase to decode it (server-side). Returns the
// user's profile from user_profiles, or null if token is invalid/expired/missing.
export async function getCurrentUser(req: NextApiRequest): Promise<PortalUser | null> {
  const token = getToken(req)
  if (!token) return null

  const sb = getServiceClient()
  const { data: authData, error: authErr } = await sb.auth.getUser(token)
  if (authErr || !authData?.user) return null

  const { data: profile, error: profileErr } = await sb
    .from('user_profiles')
    .select('id, email, display_name, role, is_active')
    .eq('id', authData.user.id)
    .single()

  if (profileErr || !profile) return null
  if (!profile.is_active) return null

  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    role: profile.role as UserRole,
    isActive: profile.is_active,
  }
}

// Gate an API route by permission. Call like:
//   export default withAuth('view:dashboards', async (req, res, user) => { ... })
export function withAuth<T = any>(
  permission: Permission | Permission[] | null,
  handler: (req: NextApiRequest, res: NextApiResponse, user: PortalUser) => Promise<T> | T,
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const user = await getCurrentUser(req)
    if (!user) {
      return res.status(401).json({ error: 'Unauthenticated' })
    }

    if (permission !== null) {
      const perms = Array.isArray(permission) ? permission : [permission]
      const ok = perms.every(p => roleHasPermission(user.role, p))
      if (!ok) {
        return res.status(403).json({ error: 'Forbidden — insufficient permissions', required: perms, role: user.role })
      }
    }

    return handler(req, res, user)
  }
}

// Write to the audit log (fire-and-forget — don't block on failures)
export async function audit(actor: PortalUser | null, action: string, details?: {
  target_user_id?: string
  target_email?: string
  [key: string]: any
}) {
  try {
    const sb = getServiceClient()
    await sb.from('auth_audit_log').insert({
      actor_id: actor?.id || null,
      actor_email: actor?.email || null,
      action,
      target_user_id: details?.target_user_id || null,
      target_email: details?.target_email || null,
      details: details ? { ...details } : null,
    })
  } catch (e) {
    console.error('audit log failed:', e)
  }
}

// Helper for getServerSideProps — returns { props: { user } } or redirect to /login
export async function requirePageAuth(context: any, permission: Permission | null = null) {
  // Reconstruct a minimal req-like object from the Next context
  const req = context.req as NextApiRequest
  const user = await getCurrentUser(req)
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } }
  }
  if (permission && !roleHasPermission(user.role, permission)) {
    return { redirect: { destination: '/?forbidden=1', permanent: false } }
  }
  return {
    props: {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
    },
  }
}

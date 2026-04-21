// lib/auth.ts
// Authentication helpers. Backed by Supabase Auth — verifies JWT from the
// httpOnly cookie `ja-portal-access-token` (set by /api/auth/session).
//
// API keeps the same shape as the previous bcrypt-based version so existing
// routes that import `requireAuth` / `requireAdmin` / `getSessionUser` keep
// working without changes.

import { NextApiRequest, NextApiResponse } from 'next'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Legacy types kept for API compatibility. `role` now includes the new
// 5-role set, not just admin/sales.
export type Role = 'admin' | 'manager' | 'sales' | 'accountant' | 'viewer'

export interface SessionUser {
  id: string
  username: string     // legacy alias for email (some old code referenced it)
  email: string
  role: Role
  displayName: string
  issuedAt: number
  visibleTabs?: string[] | null  // null/undefined = use role defaults, array = per-user override
}

// Service-role Supabase client (lazy singleton)
let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// Read the JWT from Authorization header or our httpOnly cookie.
function extractToken(req: NextApiRequest): string | null {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const c = req.cookies['ja-portal-access-token']
  return c || null
}

// Verify + load profile. Returns null if unauthenticated/inactive/invalid.
// Caches per-request via a WeakMap keyed on req (so repeated calls are free).
const _cache = new WeakMap<NextApiRequest, SessionUser | null>()

async function loadUser(req: NextApiRequest): Promise<SessionUser | null> {
  if (_cache.has(req)) return _cache.get(req) || null

  const token = extractToken(req)
  if (!token) { _cache.set(req, null); return null }

  try {
    const { data: authData, error: authErr } = await sb().auth.getUser(token)
    if (authErr || !authData?.user) { _cache.set(req, null); return null }

    const { data: profile } = await sb()
      .from('user_profiles')
      .select('id, email, display_name, role, is_active, visible_tabs')
      .eq('id', authData.user.id)
      .single()

    if (!profile || !profile.is_active) { _cache.set(req, null); return null }

    const u: SessionUser = {
      id: profile.id,
      email: profile.email,
      username: profile.email,
      role: profile.role as Role,
      displayName: profile.display_name || profile.email,
      issuedAt: Date.now(),
      visibleTabs: (profile as any).visible_tabs || null,
    }
    _cache.set(req, u)
    return u
  } catch {
    _cache.set(req, null)
    return null
  }
}

// ── Public helpers (same names/signatures as before) ──────────────────────

export async function isAuthenticated(req: NextApiRequest): Promise<boolean> {
  const u = await loadUser(req)
  return !!u
}

export async function getSessionUser(req: NextApiRequest): Promise<SessionUser | null> {
  return loadUser(req)
}

// Wrap an API route handler. Handler is called only if authenticated.
// Signature matches the prior version exactly so no call sites need to change.
export async function requireAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: () => Promise<void>
): Promise<void> {
  const u = await loadUser(req)
  if (!u) { res.status(401).json({ error: 'Unauthorised' }); return }
  await handler()
}

// Admin-only. Rejects any non-admin role.
export async function requireAdmin(
  req: NextApiRequest,
  res: NextApiResponse,
  handler: () => Promise<void>
): Promise<void> {
  const u = await loadUser(req)
  if (!u) { res.status(401).json({ error: 'Unauthorised' }); return }
  if (u.role !== 'admin') { res.status(403).json({ error: 'Forbidden — admin only' }); return }
  await handler()
}

// Role-gated variant — rejects unless the user has ONE of the allowed roles.
// Added for new routes that want fine-grained gating without writing the check inline.
export async function requireRole(
  req: NextApiRequest,
  res: NextApiResponse,
  allowed: Role[],
  handler: (user: SessionUser) => Promise<void>
): Promise<void> {
  const u = await loadUser(req)
  if (!u) { res.status(401).json({ error: 'Unauthorised' }); return }
  if (!allowed.includes(u.role)) {
    res.status(403).json({ error: 'Forbidden — insufficient role', required: allowed, role: u.role })
    return
  }
  await handler(u)
}

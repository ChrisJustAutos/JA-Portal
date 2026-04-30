// lib/service-auth.ts
// Service-token authentication for external automation (GitHub Actions,
// scheduled scrapers, n8n, etc.).
//
// Tokens are issued via the admin Settings UI, stored as SHA-256 hashes in
// the service_tokens table, and presented as Bearer tokens with the
// X-Service-Token header. We deliberately use a custom header rather than
// Authorization: Bearer to avoid colliding with Supabase user sessions
// (which use the Authorization header for user JWTs).
//
// Constant-time comparison via SHA-256 hash equality. The plaintext token
// is shown to the admin exactly once at creation time.

import { NextApiRequest, NextApiResponse } from 'next'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export interface ServiceTokenContext {
  id: string
  name: string
  scopes: string[]
}

/**
 * Validate the X-Service-Token header (or x-service-token, case-insensitive).
 * Returns the matching token row if valid + active + has the required scope.
 *
 * On invalid / inactive / wrong scope: returns null. Caller responds 401/403.
 */
export async function validateServiceToken(
  req: NextApiRequest,
  requiredScope: string,
): Promise<ServiceTokenContext | null> {
  const raw =
    (req.headers['x-service-token'] as string | undefined) ??
    (req.headers['X-Service-Token' as any] as string | undefined)
  if (!raw || typeof raw !== 'string' || raw.length < 16) return null

  const hash = hashToken(raw.trim())
  const { data, error } = await sb()
    .from('service_tokens')
    .select('id, name, scopes, is_active')
    .eq('token_hash', hash)
    .eq('is_active', true)
    .maybeSingle()
  if (error || !data) return null
  if (!data.scopes?.includes(requiredScope)) return null

  // Best-effort last-used update — fire and forget. Don't await; don't fail
  // the request if it errors.
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    null
  void sb()
    .from('service_tokens')
    .update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
    .eq('id', data.id)
    .then(() => undefined, () => undefined)

  return { id: data.id, name: data.name, scopes: data.scopes }
}

/**
 * Wrapper for an API route handler that allows EITHER:
 *   • An admin user session (existing requireAdmin behaviour), OR
 *   • A valid service token with the given scope.
 *
 * This lets the same upload endpoint be used by the in-portal UI (admin auth)
 * AND by GitHub Actions / external automation (service token).
 */
export async function requireAdminOrServiceToken(
  req: NextApiRequest,
  res: NextApiResponse,
  requiredScope: string,
  handler: (auth: { kind: 'user'; userId: string | null } | { kind: 'service'; tokenId: string; tokenName: string }) => Promise<void>,
): Promise<void> {
  // 1. Try service token first (cheaper — single indexed lookup, no JWT decode)
  const svc = await validateServiceToken(req, requiredScope)
  if (svc) {
    await handler({ kind: 'service', tokenId: svc.id, tokenName: svc.name })
    return
  }

  // 2. Fall back to user session (admin only)
  // Lazy import to avoid circular deps if auth.ts imports anything from here
  const { getSessionUser } = await import('./auth')
  const user = await getSessionUser(req)
  if (!user) { res.status(401).json({ error: 'Unauthorised — sign in or provide X-Service-Token' }); return }
  if (user.role !== 'admin') { res.status(403).json({ error: 'Forbidden — admin only' }); return }
  await handler({ kind: 'user', userId: user.id })
}

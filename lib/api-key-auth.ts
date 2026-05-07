// lib/api-key-auth.ts
//
// Bearer-token auth for service / automation endpoints that need to be
// callable WITHOUT a portal user session — e.g. crons, webhooks, or
// "do this on my behalf" calls from a remote LLM session.
//
// Usage:
//   const auth = checkBearer(req, 'AP_AUTOMATION_API_KEY')
//   if (!auth.ok) return res.status(401).json({ error: auth.reason })
//
// The token is compared against process.env[envVarName] using
// crypto.timingSafeEqual to avoid leaking length / matching prefix
// information through response timing.

import type { NextApiRequest } from 'next'
import { timingSafeEqual } from 'node:crypto'

export interface BearerCheckResult {
  ok: boolean
  /** Why auth failed — never expose to client unless it's the misconfigured-server case. */
  reason?: string
}

export function checkBearer(req: NextApiRequest, envVarName: string): BearerCheckResult {
  const expected = process.env[envVarName]
  if (!expected || expected.length < 16) {
    // Treat short/empty keys as misconfiguration. Refuse loudly so the
    // caller fixes their env, rather than silently letting a 1-char key
    // gate production.
    return { ok: false, reason: `${envVarName} not configured (or too short — set a 32+ char random string)` }
  }
  const auth = String(req.headers.authorization || req.headers.Authorization || '')
  if (!auth.startsWith('Bearer ')) return { ok: false, reason: 'Missing Bearer token' }
  const presented = auth.slice(7).trim()
  if (presented.length === 0) return { ok: false, reason: 'Empty bearer token' }
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { ok: false, reason: 'Invalid token' }
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'Invalid token' }
}

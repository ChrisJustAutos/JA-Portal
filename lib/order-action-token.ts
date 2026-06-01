// lib/order-action-token.ts
// SERVER-ONLY. Stateless signed tokens for login-less order action links
// (e.g. the "Book Freight" button in the admin order-placed email). HMAC-SHA256
// over orderId|scope|exp with ADMIN_ACTION_SECRET; no DB row needed because the
// underlying actions are idempotent (booking refuses if already booked).

import { createHmac, timingSafeEqual } from 'crypto'

export type OrderActionScope = 'book_freight'

function secret(): string {
  const s = process.env.ADMIN_ACTION_SECRET
  if (!s) throw new Error('ADMIN_ACTION_SECRET is not set')
  return s
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', secret()).update(payload).digest())
}

// token = base64url(payload).<sig>  where payload = orderId|scope|expEpochSec
export function signOrderAction(input: { orderId: string; scope: OrderActionScope; ttlDays?: number }): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlDays ?? 14) * 86400
  const payload = `${input.orderId}|${input.scope}|${exp}`
  const body = b64url(Buffer.from(payload, 'utf8'))
  return `${body}.${sign(payload)}`
}

export function verifyOrderAction(token: string, expectedScope: OrderActionScope): { orderId: string } | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  let payload: string
  try { payload = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { return null }
  const parts = payload.split('|')
  if (parts.length !== 3) return null
  const [orderId, scope, expStr] = parts
  // Constant-time signature compare.
  const expected = sign(payload)
  const a = Buffer.from(sig || ''), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (scope !== expectedScope) return null
  const exp = parseInt(expStr, 10)
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null
  return { orderId }
}

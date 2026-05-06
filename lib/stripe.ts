// lib/stripe.ts
//
// Lightweight Stripe API wrapper. Uses raw fetch + form-encoding rather
// than the official Stripe SDK to avoid adding ~1MB of dependencies.
// We only need a tiny slice of the API: creating checkout sessions,
// retrieving sessions, and verifying webhook signatures.
//
// Required env vars:
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET  — whsec_... from the Stripe webhook endpoint config

import { createHmac } from 'crypto'

const STRIPE_API = 'https://api.stripe.com/v1'

function key(): string {
  const k = process.env.STRIPE_SECRET_KEY
  if (!k) throw new Error('STRIPE_SECRET_KEY env var not set')
  return k
}

// Convert a nested JS object to Stripe's flat form-encoded shape:
//   { line_items: [{ price_data: { currency: 'aud' } }] }
//   →  line_items[0][price_data][currency]=aud
function stripeForm(obj: any, prefix?: string): string[] {
  const out: string[] = []
  if (obj === null || obj === undefined) return out

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      out.push(...stripeForm(v, `${prefix}[${i}]`))
    })
  } else if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const child = prefix ? `${prefix}[${k}]` : k
      out.push(...stripeForm(obj[k], child))
    }
  } else {
    if (!prefix) return out
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`)
  }
  return out
}

async function stripeRequest(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${key()}`,
  }
  let init: any = { method, headers }
  if (method === 'POST' && body) {
    init.body = stripeForm(body).join('&')
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  const res = await fetch(`${STRIPE_API}${path}`, init)
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  if (!res.ok) {
    const msg = json?.error?.message || text || `HTTP ${res.status}`
    throw new Error(`Stripe ${method} ${path} failed: ${msg}`)
  }
  return json
}

// ── Checkout sessions ───────────────────────────────────────────────────

export interface StripeLineItem {
  price_data: {
    currency: string  // 'aud'
    product_data: {
      name: string
      description?: string
    }
    unit_amount: number  // integer cents
    tax_behavior?: 'inclusive' | 'exclusive' | 'unspecified'
  }
  quantity: number
}

export interface CreateCheckoutSessionParams {
  line_items: StripeLineItem[]
  success_url: string
  cancel_url: string
  customer_email?: string
  metadata?: Record<string, string>
  payment_intent_data?: {
    metadata?: Record<string, string>
    description?: string
  }
}

export interface StripeCheckoutSession {
  id: string
  url: string
  payment_status: string
  status: string
  payment_intent: string | null
  amount_total: number
  currency: string
  metadata: Record<string, string>
  customer_email: string | null
}

export async function createCheckoutSession(p: CreateCheckoutSessionParams): Promise<StripeCheckoutSession> {
  return stripeRequest('POST', '/checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: p.line_items,
    success_url: p.success_url,
    cancel_url: p.cancel_url,
    customer_email: p.customer_email,
    metadata: p.metadata || {},
    payment_intent_data: p.payment_intent_data,
  })
}

export async function retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSession> {
  return stripeRequest('GET', `/checkout/sessions/${sessionId}`)
}

// ── Webhook signature verification ──────────────────────────────────────
// Stripe-Signature header format: t=1698765432,v1=abcdef...,v0=oldhash...
// We compute HMAC-SHA256 of "${timestamp}.${rawBody}" and compare to v1.
// 5-minute tolerance window (Stripe's default) to reject replay attempts.

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret?: string,
): { ok: true; event: any } | { ok: false; error: string } {
  const whSecret = secret || process.env.STRIPE_WEBHOOK_SECRET
  if (!whSecret) return { ok: false, error: 'STRIPE_WEBHOOK_SECRET not set' }
  if (!signatureHeader) return { ok: false, error: 'Stripe-Signature header missing' }

  // Parse the header
  const parts: Record<string, string[]> = {}
  for (const seg of signatureHeader.split(',')) {
    const [k, v] = seg.split('=', 2).map(s => s.trim())
    if (!k || !v) continue
    if (!parts[k]) parts[k] = []
    parts[k].push(v)
  }
  const ts = parts['t']?.[0]
  const v1s = parts['v1'] || []
  if (!ts || v1s.length === 0) return { ok: false, error: 'Malformed Stripe-Signature header' }

  // Reject if timestamp outside tolerance
  const now = Math.floor(Date.now() / 1000)
  const tsNum = parseInt(ts, 10)
  if (!isFinite(tsNum)) return { ok: false, error: 'Bad timestamp in signature' }
  if (Math.abs(now - tsNum) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, error: 'Webhook timestamp outside tolerance' }
  }

  // Compute expected HMAC
  const expected = createHmac('sha256', whSecret)
    .update(`${ts}.${rawBody}`)
    .digest('hex')

  // Constant-time compare against any v1 candidate
  if (!v1s.some(sig => timingSafeEqualHex(sig, expected))) {
    return { ok: false, error: 'Signature mismatch' }
  }

  // Parse the body now that signature is verified
  try {
    return { ok: true, event: JSON.parse(rawBody) }
  } catch (e: any) {
    return { ok: false, error: `JSON parse failed after signature verification: ${e?.message}` }
  }
}

// Constant-time hex string comparison (avoid early-return timing leaks)
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

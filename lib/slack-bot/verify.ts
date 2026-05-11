// lib/slack-bot/verify.ts
//
// Slack request signing verification (HMAC SHA-256 over `v0:{ts}:{rawBody}`,
// secret = SLACK_SIGNING_SECRET). Rejects timestamps older than 5 min to
// defeat replay attacks.
//
// https://api.slack.com/authentication/verifying-requests-from-slack

import { createHmac, timingSafeEqual } from 'crypto'

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!timestamp || !signature) return { ok: false, reason: 'missing-headers' }
  const tsNum = Number(timestamp)
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'bad-timestamp' }
  if (Math.abs(Date.now() / 1000 - tsNum) > 60 * 5) return { ok: false, reason: 'stale-timestamp' }

  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret) return { ok: false, reason: 'no-signing-secret' }

  const base = `v0:${timestamp}:${rawBody}`
  const expected = 'v0=' + createHmac('sha256', secret).update(base).digest('hex')

  try {
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length) return { ok: false, reason: 'sig-length' }
    if (!timingSafeEqual(a, b)) return { ok: false, reason: 'sig-mismatch' }
  } catch {
    return { ok: false, reason: 'sig-compare-failed' }
  }
  return { ok: true }
}

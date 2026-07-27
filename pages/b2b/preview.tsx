// pages/b2b/preview.tsx
// Landing page for the admin "Preview portal" / Scribe link. Validates the
// signed b2b_preview token, sets the read-only preview cookie, and redirects
// into the distributor portal. From there every page renders as that
// distributor but withB2BAuth blocks all mutations (see lib/b2bAuthServer).

import type { GetServerSidePropsContext } from 'next'
import { serialize } from 'cookie'
import { B2B_PREVIEW_COOKIE } from '../../lib/b2bAuthServer'

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const token = String(ctx.query.token || '')
  const { verifyOrderAction } = await import('../../lib/order-action-token')
  const ok = token ? verifyOrderAction(token, 'b2b_preview' as any) : null
  if (!ok) {
    return { redirect: { destination: '/b2b/login?preview=expired', permanent: false } }
  }
  // Set the preview cookie (mirrors the token's own expiry window loosely at 1
  // day; the token's signature/exp is the real gate on every request).
  ctx.res.setHeader('Set-Cookie', serialize(B2B_PREVIEW_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24,
  }))
  return { redirect: { destination: '/b2b', permanent: false } }
}

export default function B2BPreviewLanding() {
  return null
}

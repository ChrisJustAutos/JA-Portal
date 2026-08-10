// components/SessionKeeper.tsx
// Keeps the httpOnly session cookies in lockstep with the browser's Supabase
// session. THE BUG THIS FIXES (Chris 2026-08-10): the cookie was written ONCE
// at login and never again — when the Supabase SDK rotated the access token,
// every SSR/API check kept validating the stale cookie until it expired, and
// users "randomly" showed unauthenticated (usually noticed around deploys,
// whose reload forces a fresh SSR pass). Now every token refresh re-posts the
// fresh tokens to the session endpoint (silent — no audit row, no last-login
// bump), so the cookie stays valid as long as the browser session does
// (30 days), across deploys, overnight, all of it.
//
// Auth pages are excluded: on /login and /b2b/login a SIGNED_IN event fires
// BEFORE the MFA step, and syncing there would mint a cookie that bypasses
// the authenticator gate. Those pages set the cookie themselves at the right
// moment.

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { getSupabase } from '../lib/supabaseClient'

const AUTH_PATHS = ['/login', '/reset-password', '/b2b/login', '/b2b/welcome']

export default function SessionKeeper() {
  const router = useRouter()
  const lastSynced = useRef<string | null>(null)
  const pathRef = useRef(router.pathname)
  pathRef.current = router.pathname

  useEffect(() => {
    let supabase
    try { supabase = getSupabase() } catch { return }

    const sync = (session: { access_token?: string; refresh_token?: string } | null) => {
      const path = pathRef.current
      if (AUTH_PATHS.some(p => path === p || path.startsWith(p + '/'))) return
      if (!session?.access_token || session.access_token === lastSynced.current) return
      lastSynced.current = session.access_token
      const endpoint = path === '/b2b' || path.startsWith('/b2b/') ? '/api/b2b/auth/session' : '/api/auth/session'
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, silent: true }),
      }).catch(() => { /* transient failure — next refresh retries */ })
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event: string, session: any) => {
      if ((event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) sync(session)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  return null
}

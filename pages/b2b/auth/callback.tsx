// pages/b2b/auth/callback.tsx
//
// Distributor magic-link landing page.
//
// When a distributor clicks the invite email link, Supabase redirects them
// here with the access/refresh tokens in the URL hash. The Supabase JS SDK
// is configured with detectSessionInUrl: true, so it auto-processes the
// hash and creates a session in localStorage.
//
// We just need to:
//   1. Wait for the session to be available
//   2. Update the distributor user's last_login_at (best-effort)
//   3. Redirect to /b2b
//
// Note: this page shares the storageKey 'ja-portal-auth' with staff sessions.
// A staff user signing in here would still create a B2B session, but the
// staff portal's requirePageAuth checks user_profiles, which distributor
// users don't have — so they'd just bounce back to /login. Acceptable for V1.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', red:'#f04e4e',
}

export default function B2BAuthCallback() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'pending'|'success'|'error'>('pending')

  useEffect(() => {
    const supabase = getSupabase()
    let cancelled = false

    async function check() {
      // The SDK has a small window during which it's still parsing the URL hash.
      // Poll briefly rather than racing it.
      for (let i = 0; i < 20; i++) {
        if (cancelled) return
        const { data, error } = await supabase.auth.getSession()
        if (error) {
          setError(error.message || 'Sign-in failed')
          setStatus('error')
          return
        }
        if (data.session) {
          // Best-effort: update last_login_at via the API.
          // Don't block the redirect on this.
          fetch('/api/b2b/auth/check-in', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: data.session.access_token }),
          }).catch(() => {})

          if (cancelled) return
          setStatus('success')
          // Brief pause so the user sees confirmation
          setTimeout(() => router.replace('/b2b'), 600)
          return
        }
        await new Promise(r => setTimeout(r, 150))
      }
      // No session after 3 seconds — invite link probably expired or invalid
      setError('Could not establish a session. The invite link may have expired — ask your account manager to send a new one.')
      setStatus('error')
    }
    check()

    return () => { cancelled = true }
  }, [router])

  return (
    <>
      <Head><title>Signing in · Just Autos B2B</title></Head>
      <div style={{
        minHeight:'100vh',background:T.bg,color:T.text,
        fontFamily:'system-ui,-apple-system,sans-serif',
        display:'flex',alignItems:'center',justifyContent:'center',padding:20,
      }}>
        <div style={{
          maxWidth:420,width:'100%',
          background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
          padding:'32px 28px',textAlign:'center',
        }}>
          {status === 'pending' && (
            <>
              <div style={{fontSize:32,marginBottom:12}}>🔐</div>
              <div style={{fontSize:16,fontWeight:600,marginBottom:6}}>Signing you in…</div>
              <div style={{fontSize:12,color:T.text3}}>Verifying your magic link.</div>
            </>
          )}
          {status === 'success' && (
            <>
              <div style={{fontSize:32,marginBottom:12,color:T.green}}>✓</div>
              <div style={{fontSize:16,fontWeight:600,marginBottom:6}}>Signed in</div>
              <div style={{fontSize:12,color:T.text3}}>Taking you to the portal…</div>
            </>
          )}
          {status === 'error' && (
            <>
              <div style={{fontSize:32,marginBottom:12,color:T.red}}>!</div>
              <div style={{fontSize:16,fontWeight:600,marginBottom:6}}>Sign-in failed</div>
              <div style={{fontSize:12,color:T.text2,lineHeight:1.5,marginBottom:16}}>
                {error}
              </div>
              <a href="/b2b/login"
                style={{
                  display:'inline-block',padding:'9px 18px',borderRadius:6,
                  border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
                  fontSize:12,fontWeight:500,textDecoration:'none',
                }}>
                Request a new link
              </a>
            </>
          )}
        </div>
      </div>
    </>
  )
}

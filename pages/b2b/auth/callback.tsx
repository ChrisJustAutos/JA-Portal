// pages/b2b/auth/callback.tsx
//
// Distributor magic-link landing page.
//
// Flow on click of magic link:
//   1. Land here with #access_token=... in URL
//   2. Supabase JS SDK auto-processes the hash and creates a localStorage session
//   3. We POST the access_token to /api/b2b/auth/session, which:
//        - verifies the token resolves to an active b2b_distributor_users row
//        - sets the httpOnly cookie used by getServerSideProps on /b2b/* pages
//   4. Redirect to /b2b/catalogue
//
// Note: the storageKey 'ja-portal-auth' is shared with staff sessions but
// the cookies are separate (`ja-b2b-access-token` vs `ja-portal-access-token`),
// so SSR auth on staff vs distributor pages stays cleanly partitioned.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519',
  border:'rgba(255,255,255,0.07)',
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
      // Wait for the SDK to parse the URL hash and create a session
      let session: any = null
      for (let i = 0; i < 20; i++) {
        if (cancelled) return
        const { data, error } = await supabase.auth.getSession()
        if (error) {
          setError(error.message || 'Sign-in failed')
          setStatus('error')
          return
        }
        if (data.session) { session = data.session; break }
        await new Promise(r => setTimeout(r, 150))
      }
      if (!session) {
        setError('Could not establish a session. The invite link may have expired — ask your account manager to send a new one.')
        setStatus('error')
        return
      }

      // Set the SSR cookie (also bumps last_login_at server-side)
      try {
        const r = await fetch('/api/b2b/auth/session', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: session.access_token,
            refresh_token: session.refresh_token,
          }),
        })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j?.error || `Session setup failed (HTTP ${r.status})`)
        }
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message || 'Session setup failed')
        setStatus('error')
        return
      }

      if (cancelled) return
      setStatus('success')
      setTimeout(() => router.replace('/b2b/catalogue'), 500)
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
              <div style={{fontSize:12,color:T.text3}}>Taking you to the catalogue…</div>
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

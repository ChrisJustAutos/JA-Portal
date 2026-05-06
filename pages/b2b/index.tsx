// pages/b2b/index.tsx
//
// Placeholder distributor dashboard. After magic-link sign-in, this is
// where the user lands. For chunk 2, just confirms they're signed in and
// shows their distributor info. Chunk 3 will replace this with the
// real catalogue browse + cart + orders interface.
//
// Auth check is client-side. We hit the check-in endpoint which verifies
// the token AND tells us which distributor the user belongs to.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

interface SessionInfo {
  email: string
  distributor_id: string | null
}

export default function B2BIndexPage() {
  const router = useRouter()
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function signOut() {
    try { await getSupabase().auth.signOut() } catch {}
    router.replace('/b2b/login')
  }

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const supabase = getSupabase()
        const { data: { session } } = await supabase.auth.getSession()
        if (!session) {
          router.replace('/b2b/login')
          return
        }

        // Confirm linkage to a distributor
        const r = await fetch('/api/b2b/auth/check-in', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: session.access_token }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)

        if (cancelled) return
        if (!j.linked) {
          setError('Your sign-in worked, but this email isn\'t linked to a distributor account. Contact your account manager.')
        } else {
          setInfo({
            email: session.user.email || '',
            distributor_id: j.distributor_id,
          })
        }
      } catch (e: any) {
        setError(e?.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    check()
    return () => { cancelled = true }
  }, [router])

  return (
    <>
      <Head><title>Just Autos B2B Portal</title></Head>
      <div style={{minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>

        {/* Top bar */}
        <header style={{
          padding:'14px 20px',borderBottom:`1px solid ${T.border}`,
          display:'flex',alignItems:'center',justifyContent:'space-between',gap:16,
          background:T.bg2,
        }}>
          <div>
            <div style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:2}}>
              Just Autos
            </div>
            <div style={{fontSize:14,fontWeight:600}}>Distributor Portal</div>
          </div>
          {info && (
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <span style={{fontSize:11,color:T.text2}}>{info.email}</span>
              <button onClick={signOut}
                style={{padding:'5px 11px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                Sign out
              </button>
            </div>
          )}
        </header>

        <main style={{maxWidth:720,margin:'40px auto',padding:'0 20px'}}>
          {loading && (
            <div style={{padding:24,textAlign:'center',color:T.text3,fontSize:12}}>
              Loading…
            </div>
          )}

          {error && (
            <div style={{
              padding:18,background:`${T.amber}10`,border:`1px solid ${T.amber}40`,
              borderRadius:8,color:T.amber,fontSize:13,lineHeight:1.5,
            }}>
              {error}
              <div style={{marginTop:14}}>
                <button onClick={signOut}
                  style={{padding:'7px 12px',borderRadius:5,border:`1px solid ${T.amber}60`,background:'transparent',color:T.amber,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                  Sign out
                </button>
              </div>
            </div>
          )}

          {info && !error && (
            <div style={{
              background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
              padding:'28px 26px',
            }}>
              <div style={{fontSize:32,marginBottom:14}}>👋</div>
              <h1 style={{fontSize:22,fontWeight:600,margin:'0 0 10px',letterSpacing:'-0.01em'}}>
                Welcome to the JAWS Distributor Portal
              </h1>
              <p style={{fontSize:14,color:T.text2,lineHeight:1.6,margin:'0 0 20px'}}>
                You're signed in. The catalogue, ordering, and order history features are coming online over the next few weeks.
              </p>
              <div style={{
                padding:14,background:T.bg3,border:`1px solid ${T.border}`,borderRadius:7,
                fontSize:12,color:T.text3,lineHeight:1.6,
              }}>
                <strong style={{color:T.text2}}>What's next:</strong><br/>
                · Browse catalogue with live pricing and stock<br/>
                · Place orders paid online via Stripe<br/>
                · View order history including any linked sister accounts
              </div>
              <div style={{marginTop:18,fontSize:11,color:T.text3}}>
                Questions? Contact your account manager at Just Autos.
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  )
}

// pages/b2b/login.tsx
//
// Distributor magic-link login.
// They enter their email → we ask Supabase to send them a magic link.
// On click, they land at /b2b/auth/callback which establishes the session.
//
// This page does NOT create new accounts. If the email isn't already in
// b2b_distributor_users, the request fails silently from the user's POV
// (we still claim to send a link, to avoid disclosing which emails exist).

import { useState } from 'react'
import Head from 'next/head'
import { getSupabase } from '../../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', green:'#34c77b', red:'#f04e4e',
}

export default function B2BLoginPage() {
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    setSending(true)
    setError(null)
    try {
      const supabase = getSupabase()
      const baseUrl = (typeof window !== 'undefined' ? window.location.origin : 'https://ja-portal.vercel.app')
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: {
          emailRedirectTo: `${baseUrl}/b2b/auth/callback`,
          // shouldCreateUser:false would prevent self-signup. Supabase Auth
          // creates a user record on OTP if not present, but they'd have no
          // b2b_distributor_users row → check-in returns linked=false →
          // /b2b page won't load anything useful for them. Acceptable.
          shouldCreateUser: false,
        },
      })
      if (error) {
        const msg = String(error.message || '').toLowerCase()
        // Don't disclose which emails exist
        if (msg.includes('not found') || msg.includes('signups') || msg.includes('disabled')) {
          setSent(true)
          return
        }
        throw error
      }
      setSent(true)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Head><title>Sign in · Just Autos B2B</title></Head>
      <div style={{
        minHeight:'100vh',background:T.bg,color:T.text,
        fontFamily:'system-ui,-apple-system,sans-serif',
        display:'flex',alignItems:'center',justifyContent:'center',padding:20,
      }}>
        <div style={{
          maxWidth:420,width:'100%',
          background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,
          padding:'32px 28px',
        }}>
          <div style={{fontSize:12,color:T.text3,textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:8}}>
            Just Autos · Distributor Portal
          </div>
          <h1 style={{fontSize:22,fontWeight:600,margin:'0 0 18px',letterSpacing:'-0.01em'}}>
            Sign in
          </h1>

          {sent ? (
            <div>
              <div style={{
                padding:14,background:`${T.green}15`,border:`1px solid ${T.green}40`,
                borderRadius:7,color:T.green,fontSize:13,marginBottom:14,
              }}>
                ✓ If <strong>{email}</strong> is registered, we've sent a magic link.
                Check your inbox.
              </div>
              <button onClick={() => { setSent(false); setEmail('') }}
                style={{
                  padding:'8px 14px',borderRadius:5,border:`1px solid ${T.border2}`,
                  background:'transparent',color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit',
                }}>
                Try another email
              </button>
            </div>
          ) : (
            <>
              <div style={{fontSize:13,color:T.text2,marginBottom:18,lineHeight:1.5}}>
                Enter the email address your account manager registered. We'll send a magic link — no password needed.
              </div>

              <input
                type="email"
                placeholder="you@yourcompany.com.au"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && email.trim()) send() }}
                disabled={sending}
                autoFocus
                style={{
                  width:'100%',
                  background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
                  borderRadius:6,padding:'10px 12px',fontSize:13,outline:'none',
                  fontFamily:'inherit',marginBottom:12,
                }}
              />

              <button
                onClick={send}
                disabled={sending || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}
                style={{
                  width:'100%',padding:'10px 16px',borderRadius:6,
                  border:`1px solid ${sending ? T.border2 : T.blue}`,
                  background: sending ? T.bg3 : T.blue,
                  color: sending ? T.text3 : '#fff',
                  fontSize:13,fontWeight:500,cursor:sending?'wait':'pointer',fontFamily:'inherit',
                }}>
                {sending ? 'Sending…' : 'Send magic link'}
              </button>

              {error && (
                <div style={{
                  marginTop:12,padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,
                  borderRadius:5,color:T.red,fontSize:13,
                }}>
                  {error}
                </div>
              )}
            </>
          )}

          <div style={{marginTop:20,paddingTop:16,borderTop:`1px solid ${T.border}`,fontSize:12,color:T.text3,lineHeight:1.5}}>
            Are you a Just Autos staff member? <a href="/login" style={{color:T.blue,textDecoration:'none'}}>Sign in to the staff portal</a>.
          </div>
        </div>
      </div>
    </>
  )
}

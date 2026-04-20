// pages/reset-password.tsx
// User lands here from Supabase email password-reset link. Sets a new password.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', red:'#f04e4e',
}

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  // Wait for Supabase SDK to consume the token from the URL and establish a session
  useEffect(() => {
    const supabase = getSupabase()
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setReady(true)
    })
    // Also check if already recovered
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
    })
    return () => { sub.subscription.unsubscribe() }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (password !== password2) throw new Error('Passwords do not match')
      if (password.length < 8) throw new Error('Password must be at least 8 characters')

      const supabase = getSupabase()
      const { error: updErr } = await supabase.auth.updateUser({ password })
      if (updErr) throw updErr

      // Set our session cookie so the portal recognises them
      const { data: sess } = await supabase.auth.getSession()
      if (sess.session) {
        await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: sess.session.access_token,
            refresh_token: sess.session.refresh_token,
          }),
        })
      }

      router.push('/')
    } catch (e: any) {
      setError(e.message || 'Could not update password')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Head><title>Set password — Just Autos Portal</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{minHeight:'100vh',background:T.bg,color:T.text,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'DM Sans',system-ui,sans-serif",padding:20}}>
        <div style={{width:420,maxWidth:'100%'}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:28,justifyContent:'center'}}>
            <div style={{width:42,height:42,borderRadius:10,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,fontWeight:700,color:'#fff'}}>JA</div>
            <div>
              <div style={{fontSize:18,fontWeight:600}}>Just Autos</div>
              <div style={{fontSize:12,color:T.text3}}>Set your password</div>
            </div>
          </div>

          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:26}}>
            {!ready && (
              <div style={{textAlign:'center',color:T.text3,padding:30}}>
                <div style={{fontSize:24,animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div>
                <div style={{fontSize:12}}>Validating reset link…</div>
                <div style={{fontSize:10,marginTop:12,color:T.text3}}>If this takes too long, the link may have expired. Request a fresh one from the login page.</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}

            {ready && (
              <form onSubmit={handleSubmit}>
                <div style={{fontSize:13,color:T.text2,marginBottom:18,lineHeight:1.5}}>Choose a password for your account. Minimum 8 characters.</div>

                <div style={{marginBottom:14}}>
                  <div style={{fontSize:11,color:T.text3,marginBottom:5,textTransform:'uppercase',letterSpacing:'0.06em'}}>New password</div>
                  <input type="password" required minLength={8} value={password} onChange={e=>setPassword(e.target.value)}
                    style={{width:'100%',background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,borderRadius:8,padding:'10px 12px',fontSize:13,outline:'none',fontFamily:'inherit',boxSizing:'border-box'}}/>
                </div>
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:11,color:T.text3,marginBottom:5,textTransform:'uppercase',letterSpacing:'0.06em'}}>Confirm password</div>
                  <input type="password" required value={password2} onChange={e=>setPassword2(e.target.value)}
                    style={{width:'100%',background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,borderRadius:8,padding:'10px 12px',fontSize:13,outline:'none',fontFamily:'inherit',boxSizing:'border-box'}}/>
                </div>

                {error && <div style={{padding:'8px 12px',borderRadius:7,background:`${T.red}20`,border:`1px solid ${T.red}40`,color:T.red,fontSize:12,marginBottom:12}}>{error}</div>}

                <button type="submit" disabled={busy} style={{width:'100%',background:busy?T.bg3:T.blue,color:busy?T.text3:'#fff',border:'none',borderRadius:8,padding:'11px 14px',fontSize:13,fontWeight:600,cursor:busy?'wait':'pointer',fontFamily:'inherit'}}>
                  {busy ? 'Saving…' : 'Set password & sign in'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

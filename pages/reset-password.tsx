// pages/reset-password.tsx
// Lands here from a Supabase email link — either a first-time invite
// (?welcome=1, set by the user-invite flow) or a password reset. Sets the
// password, then signs in. Polished first-run experience for new users.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.08)', border2:'rgba(255,255,255,0.14)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#6b7180',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

// Lightweight password strength: 0–4 from length + character variety.
function strengthOf(pw: string): { score: number; label: string; color: string } {
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++
  const map = [
    { label: 'Too short', color: T.red },
    { label: 'Weak', color: T.red },
    { label: 'Fair', color: T.amber },
    { label: 'Good', color: T.green },
    { label: 'Strong', color: T.green },
  ]
  return { score: s, ...map[s] }
}

export default function ResetPasswordPage() {
  const router = useRouter()
  const isWelcome = router.query.welcome === '1'
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [linkBad, setLinkBad] = useState(false)
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)

  // Wait for the Supabase SDK to consume the token from the URL + establish a
  // recovery session. Grab the email to greet the user. Time out gracefully.
  useEffect(() => {
    const supabase = getSupabase()
    let settled = false
    const markReady = (e?: string | null) => { settled = true; if (e) setEmail(e); setReady(true) }
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') markReady(session?.user?.email || null)
    })
    supabase.auth.getSession().then(({ data }) => { if (data.session) markReady(data.session.user?.email || null) })
    const timer = setTimeout(() => { if (!settled) setLinkBad(true) }, 6000)
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer) }
  }, [])

  const strength = useMemo(() => strengthOf(password), [password])
  const mismatch = password2.length > 0 && password !== password2
  const canSubmit = password.length >= 8 && password === password2 && !busy

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true); setError('')
    try {
      const supabase = getSupabase()
      const { error: updErr } = await supabase.auth.updateUser({ password })
      if (updErr) throw updErr
      const { data: sess } = await supabase.auth.getSession()
      if (sess.session) {
        await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: sess.session.access_token, refresh_token: sess.session.refresh_token }),
        })
      }
      setDone(true)
      setTimeout(() => router.push('/'), 1400)
    } catch (e: any) {
      setError(e.message || 'Could not set your password')
    } finally {
      setBusy(false)
    }
  }

  const inputWrap: React.CSSProperties = { position:'relative' }
  const input: React.CSSProperties = { width:'100%', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:9, padding:'12px 44px 12px 14px', fontSize:16, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }
  const eyeBtn: React.CSSProperties = { position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:T.text3, cursor:'pointer', fontSize:12, padding:'6px 8px', fontFamily:'inherit' }
  const label: React.CSSProperties = { fontSize:11, color:T.text3, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.06em' }

  return (
    <>
      <Head><title>{isWelcome ? 'Welcome — Just Autos Portal' : 'Set password — Just Autos Portal'}</title><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/><meta name="robots" content="noindex,nofollow"/><meta name="theme-color" content="#0d0f12"/></Head>
      <div style={{minHeight:'100vh',background:T.bg,color:T.text,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'DM Sans',system-ui,sans-serif",padding:20}}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
        <div style={{width:440,maxWidth:'100%'}}>
          {/* Brand */}
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:24,justifyContent:'center'}}>
            <div style={{width:44,height:44,borderRadius:11,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:17,fontWeight:700,color:'#fff'}}>JA</div>
            <div>
              <div style={{fontSize:18,fontWeight:600}}>Just Autos</div>
              <div style={{fontSize:12,color:T.text3}}>Management Portal</div>
            </div>
          </div>

          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:16,padding:28,boxShadow:'0 20px 50px rgba(0,0,0,0.35)'}}>

            {/* Done */}
            {done && (
              <div style={{textAlign:'center',padding:'20px 0'}}>
                <div style={{width:54,height:54,borderRadius:'50%',background:`${T.green}22`,border:`1px solid ${T.green}55`,color:T.green,display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,margin:'0 auto 14px'}}>✓</div>
                <div style={{fontSize:16,fontWeight:600,marginBottom:4}}>{isWelcome ? 'You’re all set' : 'Password updated'}</div>
                <div style={{fontSize:13,color:T.text2}}>Taking you to the portal…</div>
              </div>
            )}

            {/* Loading / bad link */}
            {!done && !ready && !linkBad && (
              <div style={{textAlign:'center',color:T.text3,padding:28}}>
                <div style={{fontSize:24,animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div>
                <div style={{fontSize:12}}>Verifying your link…</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}
            {!done && !ready && linkBad && (
              <div style={{textAlign:'center',padding:'10px 0'}}>
                <div style={{fontSize:15,fontWeight:600,marginBottom:8}}>This link has expired</div>
                <div style={{fontSize:13,color:T.text2,lineHeight:1.6,marginBottom:18}}>Invite and reset links are valid for a limited time. Ask an admin to resend your invite, or request a new link from the sign-in page.</div>
                <a href="/login" style={{display:'inline-block',background:T.blue,color:'#fff',textDecoration:'none',borderRadius:9,padding:'11px 22px',fontSize:14,fontWeight:600}}>Go to sign in</a>
              </div>
            )}

            {/* Form */}
            {!done && ready && (
              <form onSubmit={handleSubmit}>
                <div style={{fontSize:19,fontWeight:700,marginBottom:6,letterSpacing:'-0.01em'}}>
                  {isWelcome ? 'Welcome to the portal' : 'Set a new password'}
                </div>
                <div style={{fontSize:13,color:T.text2,marginBottom:20,lineHeight:1.55}}>
                  {isWelcome
                    ? <>Let’s set up your account{email ? <> for <strong style={{color:T.text}}>{email}</strong></> : ''}. Choose a password to finish — you’ll use it with your email to sign in.</>
                    : <>Choose a new password{email ? <> for <strong style={{color:T.text}}>{email}</strong></> : ''}.</>}
                </div>

                <div style={{marginBottom:14}}>
                  <div style={label}>{isWelcome ? 'Create password' : 'New password'}</div>
                  <div style={inputWrap}>
                    <input type={show ? 'text' : 'password'} required minLength={8} value={password} autoFocus autoComplete="new-password"
                      onChange={e=>setPassword(e.target.value)} style={input}/>
                    <button type="button" onClick={()=>setShow(s=>!s)} style={eyeBtn}>{show ? 'Hide' : 'Show'}</button>
                  </div>
                  {/* Strength meter */}
                  {password.length > 0 && (
                    <div style={{marginTop:8}}>
                      <div style={{display:'flex',gap:4}}>
                        {[0,1,2,3].map(i => (
                          <div key={i} style={{flex:1,height:4,borderRadius:2,background: i < strength.score ? strength.color : T.bg3}}/>
                        ))}
                      </div>
                      <div style={{fontSize:11,color:strength.color,marginTop:5}}>{strength.label}{password.length < 8 ? ' · use at least 8 characters' : ''}</div>
                    </div>
                  )}
                </div>

                <div style={{marginBottom:16}}>
                  <div style={label}>Confirm password</div>
                  <div style={inputWrap}>
                    <input type={show ? 'text' : 'password'} required value={password2} autoComplete="new-password"
                      onChange={e=>setPassword2(e.target.value)} style={{...input, borderColor: mismatch ? `${T.red}88` : T.border2}}/>
                  </div>
                  {mismatch && <div style={{fontSize:11,color:T.red,marginTop:6}}>Passwords don’t match</div>}
                </div>

                {error && <div style={{padding:'9px 12px',borderRadius:8,background:`${T.red}1f`,border:`1px solid ${T.red}44`,color:T.red,fontSize:12.5,marginBottom:14,lineHeight:1.4}}>{error}</div>}

                <button type="submit" disabled={!canSubmit}
                  style={{width:'100%',background: canSubmit ? T.blue : T.bg3, color: canSubmit ? '#fff' : T.text3, border:'none', borderRadius:9, padding:'13px 14px', fontSize:15, fontWeight:600, cursor: canSubmit ? 'pointer' : 'default', fontFamily:'inherit', WebkitAppearance:'none' as any}}>
                  {busy ? 'Setting up…' : isWelcome ? 'Create account & sign in' : 'Set password & sign in'}
                </button>

                {isWelcome && (
                  <div style={{fontSize:11.5,color:T.text3,textAlign:'center',marginTop:16,lineHeight:1.6}}>
                    Tip: after signing in, you can turn on two-factor authentication under <strong style={{color:T.text2}}>Settings → My Profile</strong> for extra security.
                  </div>
                )}
              </form>
            )}
          </div>

          <div style={{textAlign:'center',marginTop:16,fontSize:10,color:T.text3}}>Just Autos Mechanical · Secure portal</div>
        </div>
      </div>
    </>
  )
}

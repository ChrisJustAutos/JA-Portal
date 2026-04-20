// pages/login.tsx — Supabase-powered login. On first ever load (no admin yet),
// offers a bootstrap flow to create the first admin account.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../lib/supabaseClient'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

type Mode = 'loading' | 'login' | 'bootstrap' | 'done'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('loading')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // On mount — figure out if we need to bootstrap or if there's already an admin
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/auth/bootstrap-check')
        if (!r.ok) throw new Error('Bootstrap check failed')
        const d = await r.json()
        setMode(d.needsBootstrap ? 'bootstrap' : 'login')
      } catch (e: any) {
        setError('Could not reach portal — ' + e.message)
        setMode('login')  // fall back to login form anyway
      }
    })()
  }, [])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data, error: signErr } = await supabase.auth.signInWithPassword({ email, password })
      if (signErr) throw signErr
      if (!data.session) throw new Error('No session returned')

      // Exchange Supabase token for our httpOnly session cookie
      const sessRes = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        }),
      })
      if (!sessRes.ok) {
        const err = await sessRes.json().catch(()=>({error:'Session setup failed'}))
        throw new Error(err.error || 'Session setup failed')
      }

      setMode('done')
      router.push('/')
    } catch (e: any) {
      setError(e.message || 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setInfo('')
    try {
      if (password !== password2) throw new Error('Passwords do not match')
      if (password.length < 8) throw new Error('Password must be at least 8 characters')

      const r = await fetch('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      })
      if (!r.ok) {
        const err = await r.json().catch(()=>({error:'Bootstrap failed'}))
        throw new Error(err.error || 'Bootstrap failed')
      }

      // Now sign in with the account we just made
      const supabase = getSupabase()
      const { data, error: signErr } = await supabase.auth.signInWithPassword({ email, password })
      if (signErr) throw signErr
      if (!data.session) throw new Error('No session after bootstrap')

      await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
        }),
      })

      setMode('done')
      router.push('/')
    } catch (e: any) {
      setError(e.message || 'Bootstrap failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleForgot() {
    if (!email) { setError('Enter your email first, then click Forgot'); return }
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      setInfo(`Password reset email sent to ${email}. Check your inbox.`)
    } catch (e: any) {
      setError(e.message || 'Could not send reset email')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Head><title>Sign in — Just Autos Portal</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{minHeight:'100vh',background:T.bg,color:T.text,display:'flex',alignItems:'center',justifyContent:'center',fontFamily:"'DM Sans',system-ui,sans-serif",padding:20}}>
        <div style={{width:420,maxWidth:'100%'}}>
          <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:28,justifyContent:'center'}}>
            <div style={{width:42,height:42,borderRadius:10,background:T.blue,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,fontWeight:700,color:'#fff'}}>JA</div>
            <div>
              <div style={{fontSize:18,fontWeight:600}}>Just Autos</div>
              <div style={{fontSize:12,color:T.text3}}>Management Portal</div>
            </div>
          </div>

          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:14,padding:26}}>

            {mode === 'loading' && (
              <div style={{textAlign:'center',color:T.text3,padding:30}}>
                <div style={{fontSize:24,animation:'spin 1s linear infinite',marginBottom:10}}>⟳</div>
                <div style={{fontSize:12}}>Loading…</div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
              </div>
            )}

            {mode === 'bootstrap' && (
              <>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:16,padding:'10px 12px',background:'rgba(52,199,123,0.1)',border:'1px solid rgba(52,199,123,0.2)',borderRadius:8}}>
                  <span style={{fontSize:16}}>🎉</span>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:T.green}}>First-time setup</div>
                    <div style={{fontSize:11,color:T.text2}}>Create the first admin account to get started.</div>
                  </div>
                </div>

                <form onSubmit={handleBootstrap}>
                  <Field label="Email">
                    <input type="email" required value={email} onChange={e=>setEmail(e.target.value)} style={inputStyle()} autoFocus/>
                  </Field>
                  <Field label="Display name (optional)">
                    <input type="text" value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. Chris Russell" style={inputStyle()}/>
                  </Field>
                  <Field label="Password">
                    <input type="password" required minLength={8} value={password} onChange={e=>setPassword(e.target.value)} style={inputStyle()}/>
                  </Field>
                  <Field label="Confirm password">
                    <input type="password" required value={password2} onChange={e=>setPassword2(e.target.value)} style={inputStyle()}/>
                  </Field>

                  {error && <Alert color={T.red}>{error}</Alert>}

                  <button type="submit" disabled={busy} style={btnPrimary(busy)}>
                    {busy ? 'Creating admin…' : 'Create first admin →'}
                  </button>
                  <div style={{fontSize:11,color:T.text3,textAlign:'center',marginTop:14,lineHeight:1.5}}>
                    This creates the <strong>first</strong> admin account. After this, new users must be invited by an admin — this form will never show again.
                  </div>
                </form>
              </>
            )}

            {mode === 'login' && (
              <form onSubmit={handleLogin}>
                <div style={{fontSize:18,fontWeight:600,marginBottom:18}}>Sign in</div>
                <Field label="Email">
                  <input type="email" required value={email} onChange={e=>setEmail(e.target.value)} style={inputStyle()} autoFocus/>
                </Field>
                <Field label="Password">
                  <input type="password" required value={password} onChange={e=>setPassword(e.target.value)} style={inputStyle()}/>
                </Field>

                {error && <Alert color={T.red}>{error}</Alert>}
                {info && <Alert color={T.green}>{info}</Alert>}

                <button type="submit" disabled={busy} style={btnPrimary(busy)}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>

                <div style={{textAlign:'center',marginTop:14}}>
                  <button type="button" onClick={handleForgot} disabled={busy}
                    style={{background:'none',border:'none',color:T.blue,fontSize:12,cursor:'pointer',fontFamily:'inherit',padding:4}}>
                    Forgot password?
                  </button>
                </div>
              </form>
            )}

            {mode === 'done' && (
              <div style={{textAlign:'center',color:T.green,padding:30,fontSize:14}}>✓ Signed in. Redirecting…</div>
            )}
          </div>

          <div style={{textAlign:'center',marginTop:16,fontSize:10,color:T.text3}}>
            JAWS + VPS · Live MYOB
          </div>
        </div>
      </div>
    </>
  )
}

function Field({label,children}:{label:string;children:React.ReactNode}) {
  return <div style={{marginBottom:14}}>
    <div style={{fontSize:11,color:T.text3,marginBottom:5,textTransform:'uppercase',letterSpacing:'0.06em'}}>{label}</div>
    {children}
  </div>
}
function inputStyle():React.CSSProperties {
  return { width:'100%', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:8, padding:'10px 12px', fontSize:13, outline:'none', fontFamily:'inherit', boxSizing:'border-box' }
}
function btnPrimary(busy:boolean):React.CSSProperties {
  return { width:'100%', background:busy?T.bg3:T.blue, color:busy?T.text3:'#fff', border:'none', borderRadius:8, padding:'11px 14px', fontSize:13, fontWeight:600, cursor:busy?'wait':'pointer', fontFamily:'inherit', marginTop:4 }
}
function Alert({children,color}:{children:React.ReactNode;color:string}) {
  return <div style={{padding:'8px 12px',borderRadius:7,background:`${color}20`,border:`1px solid ${color}40`,color,fontSize:12,marginTop:8,marginBottom:8,lineHeight:1.4}}>{children}</div>
}

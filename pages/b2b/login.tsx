// pages/b2b/login.tsx
//
// Distributor login — email + password, with an optional authenticator (TOTP)
// step, mirroring the staff sign-in. On success we POST the Supabase tokens to
// /api/b2b/auth/session to set the distributor cookie, then land on /b2b.
//
//   - No password yet? "Set / forgot password" emails a set-password link
//     (→ /reset-password?next=/b2b), which also covers newly-invited users.
//   - 2FA is opt-in: distributors enrol an authenticator in /b2b/settings; the
//     code is only requested at sign-in if they have one.

import { useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { getSupabase } from '../../lib/supabaseClient'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}

type Mode = 'login' | 'mfa' | 'forgotSent' | 'done'

export default function B2BLoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaFactorId, setMfaFactorId] = useState('')
  const [trustDevice, setTrustDevice] = useState(true)  // remember this device for 24h
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function establish(accessToken: string, refreshToken: string) {
    const r = await fetch('/api/b2b/auth/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
    })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw new Error(e.error || 'This account isn’t set up for the distributor portal.')
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const supabase = getSupabase()
      const { data, error: signErr } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
      if (signErr) throw signErr
      if (!data.session) throw new Error('No session returned')

      // Opt-in 2FA: if the account has a verified authenticator the session is
      // still AAL1 — ask for the 6-digit code before setting the cookie.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal && aal.nextLevel === 'aal2' && aal.nextLevel !== aal.currentLevel) {
        const { data: factors } = await supabase.auth.mfa.listFactors()
        const totp = factors?.totp?.[0]
        if (totp) {
          // Skip the code if this device was trusted in the last 24h.
          const trusted = await fetch('/api/b2b/auth/mfa-device', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'check', access_token: data.session.access_token }),
          }).then(r => r.ok ? r.json() : null).then(d => !!d?.trusted).catch(() => false)
          if (!trusted) { setMfaFactorId(totp.id); setMfaCode(''); setMode('mfa'); return }
        }
      }
      await establish(data.session.access_token, data.session.refresh_token)
      setMode('done'); router.push('/b2b')
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase()
      if (msg.includes('invalid login') || msg.includes('credentials')) setError('Wrong email or password. If you haven’t set a password yet, use “Set / forgot password”.')
      else setError(e?.message || 'Sign in failed')
    } finally { setBusy(false) }
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const supabase = getSupabase()
      const { error: vErr } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code: mfaCode.replace(/\s/g, '') })
      if (vErr) throw vErr
      const { data: sess } = await supabase.auth.getSession()
      if (!sess.session) throw new Error('No session after verification')
      // Trust this device for 24h so the code isn't asked again.
      if (trustDevice) {
        await fetch('/api/b2b/auth/mfa-device', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'trust', access_token: sess.session.access_token }),
        }).catch(() => {})
      }
      await establish(sess.session.access_token, sess.session.refresh_token)
      setMode('done'); router.push('/b2b')
    } catch (e: any) {
      setError(e?.message || 'Invalid code — try again')
    } finally { setBusy(false) }
  }

  async function handleForgot() {
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Enter your email above first, then tap “Set / forgot password”.'); return }
    setBusy(true); setError(null)
    try {
      const supabase = getSupabase()
      const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://justautos.app'
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${baseUrl}/reset-password?next=${encodeURIComponent('/b2b')}`,
      })
      if (error) {
        const msg = String(error.message || '').toLowerCase()
        if ((error as any).status === 429 || msg.includes('rate limit')) { setError('Too many emails were just sent. Please wait a few minutes and try again.'); return }
        throw error
      }
      setMode('forgotSent')
    } catch (e: any) {
      setError(e?.message || 'Could not send the email')
    } finally { setBusy(false) }
  }

  const inp: React.CSSProperties = { width: '100%', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '12px 14px', fontSize: 16, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }
  const primaryBtn = (disabled: boolean): React.CSSProperties => ({ width: '100%', padding: '12px 16px', borderRadius: 8, border: 'none', background: disabled ? T.bg3 : T.blue, color: disabled ? T.text3 : '#fff', fontSize: 15, fontWeight: 600, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', marginTop: 4 })

  return (
    <>
      <Head><title>Sign in · Just Autos B2B</title><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: 'system-ui,-apple-system,sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ maxWidth: 420, width: '100%', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: '32px 28px' }}>
          <div style={{ fontSize: 12, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Just Autos · Distributor Portal</div>

          {mode === 'login' && (
            <form onSubmit={handleLogin}>
              <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 18px', letterSpacing: '-0.01em' }}>Sign in</h1>
              <div style={{ fontSize: 11, color: T.text3, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Email</div>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus autoComplete="username" inputMode="email" autoCapitalize="off" spellCheck={false} style={{ ...inp, marginBottom: 14 }} />
              <div style={{ fontSize: 11, color: T.text3, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Password</div>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" style={{ ...inp, marginBottom: 4 }} />
              {error && <div style={{ marginTop: 10, padding: 10, background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 6, color: T.red, fontSize: 13, lineHeight: 1.4 }}>{error}</div>}
              <button type="submit" disabled={busy || !email.trim() || !password} style={primaryBtn(busy || !email.trim() || !password)}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button type="button" onClick={handleForgot} disabled={busy} style={{ background: 'none', border: 'none', color: T.blue, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 4 }}>Set / forgot password</button>
              </div>
            </form>
          )}

          {mode === 'mfa' && (
            <form onSubmit={handleMfa}>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>Two-factor authentication</h1>
              <div style={{ fontSize: 12.5, color: T.text2, marginBottom: 18, lineHeight: 1.5 }}>Enter the 6-digit code from your authenticator app.</div>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456" style={{ ...inp, letterSpacing: '0.3em', textAlign: 'center', fontSize: 22 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: T.text2, cursor: 'pointer', margin: '10px 0 2px' }}>
                <input type="checkbox" checked={trustDevice} onChange={e => setTrustDevice(e.target.checked)} style={{ cursor: 'pointer' }} />
                Trust this device for 24 hours
              </label>
              {error && <div style={{ marginTop: 10, padding: 10, background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 6, color: T.red, fontSize: 13 }}>{error}</div>}
              <button type="submit" disabled={busy || mfaCode.length !== 6} style={primaryBtn(busy || mfaCode.length !== 6)}>{busy ? 'Verifying…' : 'Verify & sign in'}</button>
              <div style={{ textAlign: 'center', marginTop: 14 }}>
                <button type="button" onClick={() => { setMode('login'); setError(null); setMfaCode('') }} disabled={busy} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', padding: 4 }}>← Back</button>
              </div>
            </form>
          )}

          {mode === 'forgotSent' && (
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 12px' }}>Check your email</h1>
              <div style={{ padding: 14, background: `${T.green}15`, border: `1px solid ${T.green}40`, borderRadius: 7, color: T.green, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
                If <strong>{email}</strong> is registered, we’ve emailed a link to set your password. Open it, choose a password, and you’ll be signed in.
              </div>
              <button onClick={() => { setMode('login'); setError(null) }} style={{ padding: '8px 14px', borderRadius: 5, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>← Back to sign in</button>
            </div>
          )}

          {mode === 'done' && <div style={{ textAlign: 'center', color: T.green, padding: 30, fontSize: 14 }}>✓ Signed in. Redirecting…</div>}

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}`, fontSize: 12, color: T.text3, lineHeight: 1.5 }}>
            Are you a Just Autos staff member? <a href="/login" style={{ color: T.blue, textDecoration: 'none' }}>Sign in to the staff portal</a>.
          </div>
        </div>
      </div>
    </>
  )
}

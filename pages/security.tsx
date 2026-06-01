// pages/security.tsx
// Staff security / two-factor authentication. Any authenticated staff member can
// enrol an authenticator (TOTP) here. Uses Supabase's native MFA — the secret is
// stored by Supabase, never in our DB. Enrolling upgrades future logins to a
// password + 6-digit-code flow.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../lib/PortalTopBar'
import { requirePageAuth } from '../lib/authServer'
import { getSupabase } from '../lib/supabaseClient'
import type { UserRole } from '../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.08)', border2:'rgba(255,255,255,0.14)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }

export default function SecurityPage({ user }: Props) {
  const [loading, setLoading] = useState(true)
  const [enrolled, setEnrolled] = useState(false)        // a verified TOTP factor exists
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  // Enrolment-in-progress state
  const [enrolling, setEnrolling] = useState(false)
  const [qr, setQr] = useState('')          // SVG data URI from Supabase
  const [secret, setSecret] = useState('')
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      const supabase = getSupabase()
      const { data, error } = await supabase.auth.mfa.listFactors()
      if (error) throw error
      setEnrolled((data?.totp?.length || 0) > 0)
    } catch (e: any) {
      setError(e?.message || 'Could not load 2FA status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function startEnrol() {
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      // Clear any abandoned unverified factors first (a lingering unverified
      // factor blocks a clean re-enrol and would force a challenge at login).
      const { data: existing } = await supabase.auth.mfa.listFactors()
      for (const f of (existing?.all || [])) {
        if ((f as any).status !== 'verified') { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} }
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' })
      if (error) throw error
      setQr(data.totp.qr_code)
      setSecret(data.totp.secret)
      setFactorId(data.id)
      setCode('')
      setEnrolling(true)
    } catch (e: any) {
      setError(e?.message || 'Could not start enrolment')
    } finally {
      setBusy(false)
    }
  }

  async function confirmEnrol(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const supabase = getSupabase()
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') })
      if (error) throw error
      setEnrolling(false); setQr(''); setSecret(''); setFactorId(''); setCode('')
      setInfo('Authenticator enabled. You’ll be asked for a code next time you sign in.')
      await refresh()
    } catch (e: any) {
      setError(e?.message || 'Invalid code — check the time on your device and try again')
    } finally {
      setBusy(false)
    }
  }

  async function removeAll() {
    if (!confirm('Remove your authenticator? You will no longer be asked for a code at sign-in (until you set one up again).')) return
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data } = await supabase.auth.mfa.listFactors()
      for (const f of (data?.all || [])) { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} }
      setInfo('Authenticator removed.')
      await refresh()
    } catch (e: any) {
      setError(e?.message || 'Could not remove authenticator')
    } finally {
      setBusy(false)
    }
  }

  const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 22, maxWidth: 520 }
  const btn = (bg: string, on = true): React.CSSProperties => ({ padding: '10px 16px', borderRadius: 8, border: 'none', background: on ? bg : T.bg4, color: on ? '#fff' : T.text3, fontSize: 14, fontWeight: 600, cursor: on ? 'pointer' : 'default', fontFamily: 'inherit' })
  const input: React.CSSProperties = { width: '100%', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 8, padding: '12px 14px', fontSize: 16, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }

  return (
    <>
      <Head><title>Security — Just Autos Portal</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <div style={{ flex: 1, padding: 24 }}>
          <div style={{ maxWidth: 520, margin: '0 auto' }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '4px 0 4px' }}>Security</h1>
            <p style={{ fontSize: 13, color: T.text2, marginTop: 0, marginBottom: 18 }}>Two-factor authentication adds a 6-digit code from an app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) on top of your password.</p>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Authenticator app</span>
                {loading ? (
                  <span style={{ fontSize: 11, color: T.text3 }}>checking…</span>
                ) : enrolled ? (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: `${T.green}22`, color: T.green, border: `1px solid ${T.green}55` }}>● Active</span>
                ) : (
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: `${T.amber}22`, color: T.amber, border: `1px solid ${T.amber}55` }}>Not set up</span>
                )}
              </div>

              {info && <div style={{ fontSize: 13, color: T.green, marginBottom: 12 }}>{info}</div>}
              {error && <div style={{ fontSize: 13, color: T.red, marginBottom: 12 }}>{error}</div>}

              {!enrolling && !enrolled && !loading && (
                <button onClick={startEnrol} disabled={busy} style={btn(T.blue, !busy)}>{busy ? 'Starting…' : 'Set up authenticator'}</button>
              )}

              {!enrolling && enrolled && (
                <div>
                  <p style={{ fontSize: 13, color: T.text2, marginTop: 0 }}>Your account is protected. You’ll enter a code from your app each time you sign in.</p>
                  <button onClick={removeAll} disabled={busy} style={{ ...btn(T.bg4), color: T.red, border: `1px solid ${T.red}40` }}>{busy ? 'Working…' : 'Remove authenticator'}</button>
                </div>
              )}

              {enrolling && (
                <form onSubmit={confirmEnrol}>
                  <ol style={{ fontSize: 13, color: T.text2, paddingLeft: 18, margin: '0 0 12px', lineHeight: 1.7 }}>
                    <li>Open your authenticator app and scan this QR code:</li>
                  </ol>
                  {qr && (
                    <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block', marginBottom: 12 }}>
                      {/* Supabase returns an SVG data URI */}
                      <img src={qr} alt="2FA QR code" width={180} height={180} style={{ display: 'block' }}/>
                    </div>
                  )}
                  {secret && (
                    <div style={{ fontSize: 12, color: T.text3, marginBottom: 14 }}>
                      Can’t scan? Enter this key manually:
                      <div style={{ fontFamily: 'monospace', color: T.text, marginTop: 4, wordBreak: 'break-all', userSelect: 'all' }}>{secret}</div>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Enter the 6-digit code</div>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
                    onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456"
                    style={{ ...input, letterSpacing: '0.3em', textAlign: 'center', fontSize: 22 }}/>
                  <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                    <button type="submit" disabled={busy || code.length !== 6} style={btn(T.green, !busy && code.length === 6)}>{busy ? 'Verifying…' : 'Verify & enable'}</button>
                    <button type="button" onClick={() => { setEnrolling(false); setError('') }} disabled={busy} style={{ ...btn(T.bg4), color: T.text2 }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context)
}

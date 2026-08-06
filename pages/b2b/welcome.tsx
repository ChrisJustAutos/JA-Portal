// /b2b/welcome?t=<signed b2b_welcome token>
//
// Scanner-proof invite landing page: opening this page (what mail-security
// scanners do) touches nothing — the account is only activated when the
// human submits the set-password form. On success it signs them straight in
// and lands on the portal.

import React, { useState } from 'react'
import Head from 'next/head'
import type { GetServerSidePropsContext } from 'next'
import { getSupabase } from '../../lib/supabaseClient'

const T = {
  bg: 'var(--t-bg)', bg2: 'var(--t-bg2)', bg3: 'var(--t-bg3)',
  border: 'var(--t-border)', border2: 'var(--t-border2)',
  text: 'var(--t-text)', text2: 'var(--t-text2)', text3: 'var(--t-text3)',
  green: '#34c77b', red: '#f04e4e', blue: '#4f8ef7',
}

interface Props {
  ok: boolean
  reason?: string
  token?: string
  email?: string
  distributorName?: string
}

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const token = String(ctx.query.t || '').trim()
  if (!token) return { props: { ok: false, reason: 'Missing invite token.' } }
  const { verifyOrderAction } = await import('../../lib/order-action-token')
  const v = verifyOrderAction(token, 'b2b_welcome')
  if (!v) return { props: { ok: false, reason: 'This invite link has expired or is invalid — ask Just Autos to resend it.' } }
  const { createClient } = await import('@supabase/supabase-js')
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data: u } = await c.from('b2b_distributor_users')
    .select('email, is_active, last_login_at, distributor:b2b_distributors!b2b_distributor_users_distributor_id_fkey ( display_name )')
    .eq('id', v.orderId).maybeSingle()
  if (!u || !u.is_active) return { props: { ok: false, reason: 'This invite is no longer valid — ask Just Autos to resend it.' } }
  if (u.last_login_at) return { redirect: { destination: '/b2b/login', permanent: false } }
  const dist: any = Array.isArray(u.distributor) ? u.distributor[0] : u.distributor
  return { props: { ok: true, token, email: u.email, distributorName: dist?.display_name || 'your business' } }
}

export default function B2BWelcomePage({ ok, reason, token, email, distributorName }: Props) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (pw !== pw2) { setError("Passwords don't match."); return }
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/b2b/auth/welcome', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: pw }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      // Sign straight in with the new password, then the normal check-in.
      const { data, error: authErr } = await getSupabase().auth.signInWithPassword({ email: j.email, password: pw })
      if (authErr || !data?.session) { window.location.href = '/b2b/login?welcome=done'; return }
      try {
        await fetch('/api/b2b/auth/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ access_token: data.session.access_token, refresh_token: data.session.refresh_token }),
        })
        await fetch('/api/b2b/auth/check-in', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: data.session.access_token }),
        })
      } catch { /* best-effort */ }
      window.location.href = '/b2b'
    } catch (e: any) {
      setError(e?.message || String(e))
      setBusy(false)
    }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '11px 12px', borderRadius: 7, fontSize: 14,
    background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, fontFamily: 'inherit',
  }

  return (
    <>
      <Head><title>Welcome — Just Autos B2B Portal</title></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ width: '100%', maxWidth: 420, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: '28px 26px' }}>
          <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600, marginBottom: 6 }}>
            Just Autos · Distributor Portal
          </div>
          {!ok ? (
            <>
              <h1 style={{ fontSize: 19, fontWeight: 600, margin: '4px 0 10px' }}>Invite link problem</h1>
              <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.5 }}>{reason}</p>
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 19, fontWeight: 600, margin: '4px 0 4px' }}>Welcome, {distributorName}</h1>
              <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.5, marginBottom: 16 }}>
                Set a password for <b style={{ color: T.text }}>{email}</b> and you're in.
              </p>
              <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input type="password" autoComplete="new-password" placeholder="New password (min 8 characters)"
                  value={pw} onChange={e => setPw(e.target.value)} style={inp} autoFocus />
                <input type="password" autoComplete="new-password" placeholder="Confirm password"
                  value={pw2} onChange={e => setPw2(e.target.value)} style={inp} />
                {error && (
                  <div style={{ padding: '8px 10px', background: 'rgba(240,78,78,0.12)', border: `1px solid rgba(240,78,78,0.35)`, borderRadius: 7, color: T.red, fontSize: 12 }}>
                    {error}
                  </div>
                )}
                <button type="submit" disabled={busy} style={{
                  padding: '11px 14px', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: busy ? 'wait' : 'pointer',
                  background: T.green, color: '#08130c', border: 'none', fontFamily: 'inherit',
                }}>
                  {busy ? 'Setting up…' : 'Set password & sign in'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  )
}

// pages/b2b/settings.tsx
// Distributor Account / Settings screen. Read-only view of the company details,
// delivery & billing addresses, contact emails, and the signed-in user's
// profile. Changes are made by the account manager (admin side).

import { useEffect, useState } from 'react'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'
import { enableNotifications, ensurePushSubscription } from '../../lib/pushClient'
import { getSupabase } from '../../lib/supabaseClient'
import { useConfirm } from '../../components/ui/Feedback'

const B2B_SUBSCRIBE_URL = '/api/b2b/notifications/push-subscribe'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#aab0c0', text3:'#8d93a4',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b', amber:'#f5a623', red:'#f04e4e',
}

interface Props {
  b2bUser: {
    id: string
    email: string
    fullName: string | null
    role: 'owner' | 'member'
    distributor: { id: string; displayName: string }
  }
}

interface AccountData {
  distributor: Record<string, any>
  teamCount: number | null
  profile: { full_name: string | null; email: string; role: string }
}

export default function B2BSettingsPage({ b2bUser }: Props) {
  const [data, setData] = useState<AccountData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/b2b/account', { credentials: 'same-origin' })
        const j = await r.json()
        if (!alive) return
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        setData(j)
      } catch (e: any) { if (alive) setError(e?.message || String(e)) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [])

  const d = data?.distributor || {}
  const fmtAddr = (p: 'ship' | 'bill') => {
    const parts = [d[`${p}_line1`], d[`${p}_line2`], [d[`${p}_suburb`], d[`${p}_state`], d[`${p}_postcode`]].filter(Boolean).join(' '), d[`${p}_country`]]
      .map(x => (x == null ? '' : String(x).trim())).filter(Boolean)
    return parts
  }

  const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, marginBottom: 16 }
  const cardTitle: React.CSSProperties = { fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }

  function Field({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
    const v = value == null || String(value).trim() === '' ? '—' : String(value)
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '4px 12px', alignItems: 'baseline', padding: '5px 0', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 12, color: T.text3 }}>{label}</span>
        <span style={{ fontSize: 13, color: v === '—' ? T.text3 : T.text, fontFamily: mono ? 'monospace' : 'inherit' }}>{v}</span>
      </div>
    )
  }

  function AddressCard({ title, lines }: { title: string; lines: string[] }) {
    return (
      <div style={{ ...card, flex: 1, minWidth: 240, marginBottom: 0 }}>
        <div style={cardTitle}>{title}</div>
        {lines.length === 0
          ? <div style={{ fontSize: 13, color: T.text3 }}>Not set — contact your account manager.</div>
          : lines.map((l, i) => <div key={i} style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{l}</div>)}
      </div>
    )
  }

  return (
    <B2BLayout user={b2bUser} active="account">
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '4px 0 40px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: '8px 0 4px' }}>Settings</h1>
        <p style={{ fontSize: 12.5, color: T.text2, marginTop: 0, lineHeight: 1.6 }}>
          Your account details. To change company info or addresses, contact your account manager.
          Manage who can log in on the <a href="/b2b/team" style={{ color: T.blue, textDecoration: 'none' }}>Team</a> page.
        </p>

        {loading && <div style={{ color: T.text3, fontSize: 13, padding: 16 }}>Loading…</div>}
        {error && <div style={{ color: T.red, fontSize: 13, padding: 12, background: `${T.red}15`, border: `1px solid ${T.red}40`, borderRadius: 8 }}>{error}</div>}

        {data && (
          <>
            {/* Company */}
            <div style={card}>
              <div style={cardTitle}>Company</div>
              <Field label="Account" value={d.display_name || b2bUser.distributor.displayName} />
              <Field label="Trading name" value={d.trading_name} />
              <Field label="ABN" value={d.abn} mono />
              <Field label="Contact email" value={d.primary_contact_email} />
              <Field label="Contact phone" value={d.primary_contact_phone} />
              <Field label="Team members" value={data.teamCount != null ? `${data.teamCount} active` : null} />
            </div>

            {/* Addresses */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
              <AddressCard title="Delivery address" lines={fmtAddr('ship')} />
              <AddressCard title="Billing address" lines={fmtAddr('bill')} />
            </div>

            {/* Email routing — only show if any are set */}
            {(d.freight_email || d.invoice_email || d.instructions_email) && (
              <div style={card}>
                <div style={cardTitle}>Notification emails</div>
                <Field label="Freight / labels" value={d.freight_email} />
                <Field label="Invoices" value={d.invoice_email} />
                <Field label="Instructions" value={d.instructions_email} />
              </div>
            )}

            {/* Notifications */}
            <div style={card}>
              <div style={cardTitle}>Notifications</div>
              <NotificationsCard />
            </div>

            {/* Security / two-factor */}
            <div style={card}>
              <div style={cardTitle}>Security</div>
              <TwoFactorCard />
            </div>

            {/* Your profile */}
            <div style={card}>
              <div style={cardTitle}>Your profile</div>
              <Field label="Name" value={data.profile.full_name} />
              <Field label="Email" value={data.profile.email} />
              <Field label="Role" value={data.profile.role === 'owner' ? 'Owner' : 'Member'} />
              <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>
                You sign in with your email and password. Use “Set / forgot password” on the sign-in page to change it.
              </div>
            </div>
          </>
        )}
      </div>
    </B2BLayout>
  )
}

// Optional authenticator (TOTP) — enrol/remove, same Supabase MFA as staff.
// Once enrolled, the 6-digit code is requested at sign-in on /b2b/login.
function TwoFactorCard() {
  const confirmDialog = useConfirm()
  const [loading, setLoading] = useState(true)
  const [enrolled, setEnrolled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [qr, setQr] = useState('')
  const [secret, setSecret] = useState('')
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')

  async function refresh() {
    setError('')
    try {
      const { data, error } = await getSupabase().auth.mfa.listFactors()
      if (error) throw error
      setEnrolled((data?.totp?.length || 0) > 0)
    } catch (e: any) { setError(e?.message || 'Could not load 2FA status') }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  async function startEnrol() {
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data: existing } = await supabase.auth.mfa.listFactors()
      for (const f of (existing?.all || [])) { if ((f as any).status !== 'verified') { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} } }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' })
      if (error) throw error
      setQr(data.totp.qr_code); setSecret(data.totp.secret); setFactorId(data.id); setCode(''); setEnrolling(true)
    } catch (e: any) { setError(e?.message || 'Could not start enrolment') }
    finally { setBusy(false) }
  }

  async function confirmEnrol(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const { error } = await getSupabase().auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, '') })
      if (error) throw error
      setEnrolling(false); setQr(''); setSecret(''); setFactorId(''); setCode('')
      setInfo('Authenticator enabled. You’ll be asked for a code next time you sign in.')
      await refresh()
    } catch (e: any) { setError(e?.message || 'Invalid code — check your device clock and try again') }
    finally { setBusy(false) }
  }

  async function removeAll() {
    if (!(await confirmDialog({ title: 'Remove your authenticator?', message: 'You will no longer be asked for a code at sign-in until you set one up again.', danger: true }))) return
    setBusy(true); setError(''); setInfo('')
    try {
      const supabase = getSupabase()
      const { data } = await supabase.auth.mfa.listFactors()
      for (const f of (data?.all || [])) { try { await supabase.auth.mfa.unenroll({ factorId: f.id }) } catch {} }
      setInfo('Authenticator removed.'); await refresh()
    } catch (e: any) { setError(e?.message || 'Could not remove authenticator') }
    finally { setBusy(false) }
  }

  const inp: React.CSSProperties = { width: '100%', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '10px 12px', fontSize: 18, outline: 'none', boxSizing: 'border-box', letterSpacing: '0.3em', textAlign: 'center' }
  const btn = (bg: string, on = true): React.CSSProperties => ({ padding: '8px 16px', borderRadius: 5, border: 'none', background: on ? bg : T.bg4, color: on ? '#fff' : T.text3, fontSize: 12, fontWeight: 600, cursor: on ? 'pointer' : 'default', fontFamily: 'inherit' })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 12.5, color: T.text2 }}>Authenticator (2FA)</div>
        {loading ? <span style={{ fontSize: 10, color: T.text3 }}>checking…</span>
          : enrolled ? <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${T.green}22`, color: T.green, border: `1px solid ${T.green}55` }}>● Active</span>
          : <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: `${T.amber}22`, color: T.amber, border: `1px solid ${T.amber}55` }}>Not set up</span>}
      </div>
      <div style={{ fontSize: 11.5, color: T.text3, marginBottom: 14, lineHeight: 1.5 }}>Optional: a 6-digit code from an authenticator app (Google/Microsoft Authenticator, 1Password, Authy…) on top of your password.</div>

      {info && <div style={{ fontSize: 12, color: T.green, marginBottom: 10 }}>{info}</div>}
      {error && <div style={{ fontSize: 12, color: T.red, marginBottom: 10 }}>{error}</div>}

      {!enrolling && !enrolled && !loading && (
        <button onClick={startEnrol} disabled={busy} style={btn(T.blue, !busy)}>{busy ? 'Starting…' : 'Set up authenticator'}</button>
      )}
      {!enrolling && enrolled && (
        <button onClick={removeAll} disabled={busy} style={{ ...btn(T.bg4), color: T.red, border: `1px solid ${T.red}40` }}>{busy ? 'Working…' : 'Remove authenticator'}</button>
      )}
      {enrolling && (
        <form onSubmit={confirmEnrol}>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 10 }}>1. Scan this QR code in your authenticator app:</div>
          {qr && <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block', marginBottom: 12 }}><img src={qr} alt="2FA QR" width={170} height={170} style={{ display: 'block' }} /></div>}
          {secret && <div style={{ fontSize: 11, color: T.text3, marginBottom: 12 }}>Can’t scan? Key: <span style={{ fontFamily: 'monospace', color: T.text, userSelect: 'all', wordBreak: 'break-all' }}>{secret}</span></div>}
          <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>2. Enter the 6-digit code</div>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
            onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456" style={inp} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button type="submit" disabled={busy || code.length !== 6} style={btn(T.green, !busy && code.length === 6)}>{busy ? 'Verifying…' : 'Verify & enable'}</button>
            <button type="button" onClick={() => { setEnrolling(false); setError('') }} disabled={busy} style={{ ...btn(T.bg4), color: T.text2 }}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

// Distributor notification controls: enable push, show device count, send test.
function NotificationsCard() {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported' | 'loading'>('loading')
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  function loadCount() {
    fetch(B2B_SUBSCRIBE_URL, { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) setCount(d.count) }).catch(() => {})
  }
  useEffect(() => {
    if (typeof Notification === 'undefined') { setPerm('unsupported'); return }
    setPerm(Notification.permission)
    loadCount()
    if (Notification.permission === 'granted') ensurePushSubscription(B2B_SUBSCRIBE_URL).then(loadCount)
  }, [])

  async function enable() {
    setBusy(true); setMsg(null)
    try { const p = await enableNotifications(B2B_SUBSCRIBE_URL); setPerm(p); loadCount(); if (p !== 'granted') setMsg('Permission was not granted.') }
    finally { setBusy(false) }
  }
  async function register() {
    setBusy(true); setMsg(null)
    // Force a fresh subscription so a dead/stale endpoint (common on iOS) is replaced.
    try { const r = await ensurePushSubscription(B2B_SUBSCRIBE_URL, { force: true }); loadCount(); setMsg(r.ok ? 'Re-registered this device — try “Send test”.' : `Couldn’t register — ${r.reason || 'try reopening the app'}`) }
    finally { setBusy(false) }
  }
  async function sendTest() {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch('/api/b2b/notifications/test', { method: 'POST', credentials: 'same-origin' })
      setMsg(r.ok ? 'Test sent — you should see a notification shortly.' : 'Could not send test.')
    } finally { setBusy(false) }
  }

  const T2 = { text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4', blue: '#4f8ef7', green: '#34c77b', amber: '#f5a623', border2: 'rgba(255,255,255,0.12)' }
  const btn: React.CSSProperties = { background: T2.blue, border: 'none', color: '#fff', borderRadius: 7, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }
  const ghost: React.CSSProperties = { background: 'none', border: `1px solid ${T2.border2}`, color: T2.text2, borderRadius: 7, padding: '8px 14px', fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit' }

  return (
    <div style={{ fontSize: 13, color: T2.text2, lineHeight: 1.6 }}>
      Get order confirmations and shipping updates as pop-up notifications on this device.
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {perm === 'unsupported' && (
          <span style={{ color: T2.amber, fontSize: 12 }}>On iPhone, add this app to your Home Screen (Share → Add to Home Screen) on iOS 16.4+, then open it from the icon.</span>
        )}
        {perm === 'default' && <button onClick={enable} disabled={busy} style={btn}>{busy ? '…' : 'Enable notifications'}</button>}
        {perm === 'denied' && <span style={{ color: T2.amber, fontSize: 12 }}>Blocked — allow notifications for this site in your browser settings, then reopen the app.</span>}
        {perm === 'granted' && (count || 0) === 0 && <button onClick={register} disabled={busy} style={btn}>{busy ? '…' : 'Register this device'}</button>}
        {perm === 'granted' && (count || 0) > 0 && (
          <>
            <span style={{ color: T2.green, fontSize: 12.5 }}>✓ On · {count} device{count === 1 ? '' : 's'}</span>
            <button onClick={sendTest} disabled={busy} style={ghost}>{busy ? '…' : 'Send test'}</button>
          </>
        )}
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12, color: msg.startsWith('✓') || msg.startsWith('Test') ? T2.green : T2.amber }}>{msg}</div>}
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}

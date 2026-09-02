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
import { T } from '../../lib/ui/theme'
import { useIsMobile } from '../../lib/useIsMobile'
import { A, Banner, Btn, Card, DotLine, PageTitle, SectionLabel, StatusPill, btnStyle, inputStyle } from '../../components/b2b/ui'

const B2B_SUBSCRIBE_URL = '/api/b2b/notifications/push-subscribe'

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
  const isMobile = useIsMobile()
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

  // Label above the value on a phone, side by side on a desktop — a fixed
  // 130px label column on a 390px screen left the value unreadable.
  function Field({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
    const v = value == null || String(value).trim() === '' ? '—' : String(value)
    return (
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '130px 1fr', gap: isMobile ? 2 : '4px 12px', alignItems: 'baseline', padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 12.5, color: T.text3 }}>{label}</span>
        <span style={{ fontSize: 13, color: v === '—' ? T.text3 : T.text, fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', fontVariantNumeric: mono ? 'tabular-nums' : undefined }}>{v}</span>
      </div>
    )
  }

  function AddressCard({ title, lines }: { title: string; lines: string[] }) {
    return (
      <Card style={{ flex: 1, minWidth: 240 }}>
        <SectionLabel>{title}</SectionLabel>
        {lines.length === 0
          ? <div style={{ fontSize: 13, color: T.text3 }}>Not set — contact your account manager.</div>
          : lines.map((l, i) => <div key={i} style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{l}</div>)}
      </Card>
    )
  }

  return (
    <B2BLayout user={b2bUser} active="account">
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <PageTitle sub={<>
          Your account details. To change company info or addresses, contact your account manager.
          Manage who can log in on the <a href="/b2b/team" style={{ color: A.accent, textDecoration: 'none' }}>Team</a> page.
        </>}>
          Settings
        </PageTitle>

        {loading && <div style={{ color: T.text3, fontSize: 13, padding: 16 }}>Loading…</div>}
        {error && <div style={{ marginBottom: 16 }}><Banner tone="error">{error}</Banner></div>}

        {data && (
          <>
            {/* Company */}
            <Card style={{ marginBottom: 16 }}>
              <SectionLabel>Company</SectionLabel>
              <Field label="Account" value={d.display_name || b2bUser.distributor.displayName} />
              <Field label="Trading name" value={d.trading_name} />
              <Field label="ABN" value={d.abn} mono />
              <Field label="Contact email" value={d.primary_contact_email} />
              <Field label="Contact phone" value={d.primary_contact_phone} />
              <Field label="Team members" value={data.teamCount != null ? `${data.teamCount} active` : null} />
            </Card>

            {/* Addresses */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
              <AddressCard title="Delivery address" lines={fmtAddr('ship')} />
              <AddressCard title="Billing address" lines={fmtAddr('bill')} />
            </div>

            {/* Email routing — only show if any are set */}
            {(d.freight_email || d.invoice_email || d.instructions_email) && (
              <Card style={{ marginBottom: 16 }}>
                <SectionLabel>Notification emails</SectionLabel>
                <Field label="Freight / labels" value={d.freight_email} />
                <Field label="Invoices" value={d.invoice_email} />
                <Field label="Instructions" value={d.instructions_email} />
              </Card>
            )}

            {/* Notifications */}
            <Card style={{ marginBottom: 16 }}>
              <SectionLabel>Notifications</SectionLabel>
              <NotificationsCard />
            </Card>

            {/* Security / two-factor */}
            <Card style={{ marginBottom: 16 }}>
              <SectionLabel>Security</SectionLabel>
              <TwoFactorCard />
            </Card>

            {/* Your profile */}
            <Card style={{ marginBottom: 16 }}>
              <SectionLabel>Your profile</SectionLabel>
              <Field label="Name" value={data.profile.full_name} />
              <Field label="Email" value={data.profile.email} />
              <Field label="Role" value={data.profile.role === 'owner' ? 'Owner' : 'Member'} />
              <div style={{ fontSize: 12.5, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>
                You sign in with your email and password. Use “Set / forgot password” on the sign-in page to change it.
              </div>
            </Card>
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Authenticator (2FA)</div>
        {loading ? <span style={{ fontSize: 12, color: T.text3 }}>checking…</span>
          : enrolled ? <StatusPill color={A.good}>Active</StatusPill>
          : <StatusPill color={A.warn}>Not set up</StatusPill>}
      </div>
      <div style={{ fontSize: 12.5, color: T.text3, marginBottom: 14, lineHeight: 1.5 }}>Optional: a 6-digit code from an authenticator app (Google/Microsoft Authenticator, 1Password, Authy…) on top of your password.</div>

      {info && <div style={{ marginBottom: 10 }}><Banner tone="success">{info}</Banner></div>}
      {error && <div style={{ marginBottom: 10 }}><Banner tone="error">{error}</Banner></div>}

      {!enrolling && !enrolled && !loading && (
        <Btn onClick={startEnrol} disabled={busy}>{busy ? 'Starting…' : 'Set up authenticator'}</Btn>
      )}
      {!enrolling && enrolled && (
        <button onClick={removeAll} disabled={busy} className="al-press al-focus"
          style={{ ...btnStyle('secondary', 'md', busy), color: A.bad }}>
          {busy ? 'Working…' : 'Remove authenticator'}
        </button>
      )}
      {enrolling && (
        <form onSubmit={confirmEnrol}>
          <div style={{ fontSize: 12.5, color: T.text2, marginBottom: 10 }}>1. Scan this QR code in your authenticator app:</div>
          {qr && <div style={{ background: '#fff', padding: 12, borderRadius: 10, display: 'inline-block', marginBottom: 12 }}><img src={qr} alt="2FA QR" width={170} height={170} style={{ display: 'block' }} /></div>}
          {secret && <div style={{ fontSize: 12, color: T.text3, marginBottom: 12 }}>Can’t scan? Key: <span style={{ fontFamily: 'ui-monospace, monospace', color: T.text, userSelect: 'all', wordBreak: 'break-all' }}>{secret}</span></div>}
          <div style={{ fontSize: 12.5, color: T.text2, fontWeight: 650, marginBottom: 6 }}>2. Enter the 6-digit code</div>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code}
            onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456"
            style={{ ...inputStyle(), fontSize: 18, letterSpacing: '0.3em', textAlign: 'center' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn type="submit" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify & enable'}</Btn>
            <Btn variant="ghost" onClick={() => { setEnrolling(false); setError('') }} disabled={busy}>Cancel</Btn>
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

  return (
    <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.6 }}>
      Get order confirmations and shipping updates as pop-up notifications on this device.
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {perm === 'unsupported' && (
          <span style={{ color: A.warn, fontSize: 12.5 }}>On iPhone, add this app to your Home Screen (Share → Add to Home Screen) on iOS 16.4+, then open it from the icon.</span>
        )}
        {perm === 'default' && <Btn onClick={enable} disabled={busy}>{busy ? 'Enabling…' : 'Enable notifications'}</Btn>}
        {perm === 'denied' && <span style={{ color: A.warn, fontSize: 12.5 }}>Blocked — allow notifications for this site in your browser settings, then reopen the app.</span>}
        {perm === 'granted' && (count || 0) === 0 && <Btn onClick={register} disabled={busy}>{busy ? 'Registering…' : 'Register this device'}</Btn>}
        {perm === 'granted' && (count || 0) > 0 && (
          <>
            <DotLine color={A.good}>On · {count} device{count === 1 ? '' : 's'}</DotLine>
            <Btn variant="secondary" size="sm" onClick={sendTest} disabled={busy}>{busy ? 'Sending…' : 'Send test'}</Btn>
          </>
        )}
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: msg.startsWith('✓') || msg.startsWith('Test') ? A.good : A.warn }}>{msg}</div>}
    </div>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}

// pages/b2b/settings.tsx
// Distributor Account / Settings screen. Read-only view of the company details,
// delivery & billing addresses, contact emails, and the signed-in user's
// profile. Changes are made by the account manager (admin side).

import { useEffect, useState } from 'react'
import type { GetServerSideProps } from 'next'
import B2BLayout from '../../components/b2b/B2BLayout'
import { requireB2BPageAuth } from '../../lib/b2bAuthServer'

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

            {/* Your profile */}
            <div style={card}>
              <div style={cardTitle}>Your profile</div>
              <Field label="Name" value={data.profile.full_name} />
              <Field label="Email" value={data.profile.email} />
              <Field label="Role" value={data.profile.role === 'owner' ? 'Owner' : 'Member'} />
              <div style={{ fontSize: 11, color: T.text3, marginTop: 10, lineHeight: 1.5 }}>
                You sign in with a magic link sent to your email — there&rsquo;s no password to manage.
              </div>
            </div>
          </>
        )}
      </div>
    </B2BLayout>
  )
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return await requireB2BPageAuth(ctx) as any
}

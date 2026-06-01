// pages/order-action.tsx
// Login-less confirmation page for the admin "Book Freight" email button.
// Top-level (no portal/distributor auth wrapper). Authorization is the signed
// token in ?token=; we GET an order summary, then POST to book on confirm.

import { useEffect, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', border: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968', green: '#34c77b', red: '#f04e4e', amber: '#f5a623', blue: '#4f8ef7',
}

export default function OrderActionPage() {
  const router = useRouter()
  const token = typeof router.query.token === 'string' ? router.query.token : ''
  const [summary, setSummary] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<any>(null)

  useEffect(() => {
    if (!router.isReady) return
    if (!token) { setError('Missing token.'); return }
    fetch(`/api/b2b/order-action/freight?token=${encodeURIComponent(token)}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Invalid link'); return d })
      .then(setSummary)
      .catch(e => setError(e.message))
  }, [router.isReady, token])

  async function book() {
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/b2b/order-action/freight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      const d = await r.json()
      if (!r.ok) { setResult(d); if (!d.notConfigured && !d.alreadyBooked) setError(d.error || 'Booking failed') }
      else setResult(d)
    } catch (e: any) { setError(e?.message || 'Booking failed') }
    finally { setBusy(false) }
  }

  const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: 28, maxWidth: 480, width: '100%' }

  return (
    <>
      <Head><title>Book Freight — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans',system-ui,sans-serif", display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#fff' }}>JA</div>
            <span style={{ fontSize: 16, fontWeight: 600 }}>Book Freight</span>
          </div>

          {error && !summary && <div style={{ color: T.red, fontSize: 14 }}>{error}</div>}
          {!summary && !error && <div style={{ color: T.text3, fontSize: 13 }}>Loading order…</div>}

          {summary && (
            <>
              <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.8, marginBottom: 18 }}>
                <div><span style={{ color: T.text3 }}>Order</span> &nbsp;<strong style={{ color: T.text }}>{summary.order_number}</strong></div>
                <div><span style={{ color: T.text3 }}>Customer</span> &nbsp;{summary.distributor}</div>
                <div><span style={{ color: T.text3 }}>Ship to</span> &nbsp;{summary.ship_to || '—'}</div>
                {summary.carrier_label && <div><span style={{ color: T.text3 }}>Carrier</span> &nbsp;{summary.carrier_label}</div>}
              </div>

              {result?.ok ? (
                <div style={{ background: 'rgba(52,199,123,0.12)', border: `1px solid ${T.green}55`, borderRadius: 8, padding: 14, fontSize: 14, color: T.green }}>
                  ✓ Freight booked. Consignment <strong>{result.consignment_number || '—'}</strong>{result.tracking_number ? ` · tracking ${result.tracking_number}` : ''}.
                </div>
              ) : summary.already_booked || result?.alreadyBooked ? (
                <div style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14, fontSize: 14, color: T.text2 }}>
                  This order's freight is already booked{summary.consignment_number ? ` (consignment ${summary.consignment_number})` : ''}.
                </div>
              ) : result?.notConfigured ? (
                <div style={{ background: 'rgba(245,166,35,0.12)', border: `1px solid ${T.amber}55`, borderRadius: 8, padding: 14, fontSize: 14, color: T.amber }}>
                  Freight isn’t configured yet (MachShip API access pending). Add the MachShip token in B2B Settings, then try again.
                </div>
              ) : !summary.has_carrier ? (
                <div style={{ color: T.amber, fontSize: 14 }}>No freight quote was chosen on this order — please book manually in the portal.</div>
              ) : (
                <>
                  {error && <div style={{ color: T.red, fontSize: 13, marginBottom: 10 }}>{error}</div>}
                  <button onClick={book} disabled={busy} style={{ width: '100%', padding: '12px 0', borderRadius: 9, border: 'none', background: busy ? T.bg3 : T.green, color: busy ? T.text3 : '#fff', fontSize: 15, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                    {busy ? 'Booking…' : 'Confirm — Book Freight'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}

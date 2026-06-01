// pages/admin/b2b/test-order.tsx
// Admin tool to place a TEST order on behalf of a distributor — fires the full
// real pipeline without logging in as a distributor. Pick a distributor, add
// catalogue items, then either open a Stripe test checkout or "Mark paid" to
// run the post-payment pipeline immediately.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
}

interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }
interface Dist { id: string; display_name: string; primary_contact_email: string | null; is_active: boolean }
interface Cat { id: string; sku: string; name: string; trade_price_ex_gst: number | null }
interface Line { cat: Cat; qty: number }

const inp: React.CSSProperties = { padding: '8px 11px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }
const btn = (bg: string, on = true): React.CSSProperties => ({ padding: '9px 16px', borderRadius: 7, border: 'none', background: on ? bg : T.bg4, color: on ? '#fff' : T.text3, fontSize: 13, fontWeight: 600, cursor: on ? 'pointer' : 'default', fontFamily: 'inherit' })

export default function TestOrderPage({ user }: Props) {
  const router = useRouter()
  const [dists, setDists] = useState<Dist[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [distId, setDistId] = useState('')
  const [q, setQ] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [po, setPo] = useState('')
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<{ orderId: string; orderNumber: string; checkoutUrl: string | null; total_inc: number } | null>(null)
  const [markState, setMarkState] = useState<'idle' | 'busy' | 'done' | 'err'>('idle')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetch('/api/b2b/admin/distributors').then(r => r.json()).then(d => setDists((d.items || []).filter((x: Dist) => x.is_active))).catch(() => {})
    fetch('/api/b2b/admin/catalogue').then(r => r.json()).then(d => setCats(d.items || [])).catch(() => {})
  }, [])

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    return cats.filter(c => (c.sku || '').toLowerCase().includes(s) || (c.name || '').toLowerCase().includes(s)).slice(0, 8)
  }, [q, cats])

  const total = useMemo(() => lines.reduce((sum, l) => sum + (Number(l.cat.trade_price_ex_gst) || 0) * l.qty, 0), [lines])

  function addLine(c: Cat) { setLines(ls => ls.some(l => l.cat.id === c.id) ? ls : [...ls, { cat: c, qty: 1 }]); setQ('') }
  function setQty(id: string, qty: number) { setLines(ls => ls.map(l => l.cat.id === id ? { ...l, qty: Math.max(1, qty) } : l)) }
  function remove(id: string) { setLines(ls => ls.filter(l => l.cat.id !== id)) }

  async function create() {
    if (!distId || lines.length === 0) return
    setCreating(true); setMsg('')
    try {
      const r = await fetch('/api/b2b/admin/test-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ distributorId: distId, customerPo: po, items: lines.map(l => ({ catalogueId: l.cat.id, qty: l.qty })) }) })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Failed to create'); return }
      setResult(d); setMarkState('idle')
    } catch (e: any) { setMsg(e?.message || 'Failed') }
    finally { setCreating(false) }
  }

  async function markPaid() {
    if (!result) return
    setMarkState('busy'); setMsg('')
    try {
      const r = await fetch(`/api/b2b/admin/orders/${result.orderId}/mark-paid`, { method: 'POST' })
      const d = await r.json()
      if (!r.ok) { setMarkState('err'); setMsg(d.error || 'Mark paid failed'); return }
      setMarkState('done')
    } catch (e: any) { setMarkState('err'); setMsg(e?.message || 'Failed') }
  }

  const distEmail = dists.find(d => d.id === distId)?.primary_contact_email

  return (
    <>
      <Head><title>Test Order — B2B Admin</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, padding: 20 }}>
          <div style={{ maxWidth: 820, margin: '0 auto' }}>
            <B2BAdminTabs active="orders" />
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '18px 0' }}>
              <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Place test order</h1>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: `${T.amber}22`, color: T.amber, border: `1px solid ${T.amber}55` }}>TEST</span>
            </div>
            <p style={{ fontSize: 12.5, color: T.text2, marginTop: 0, lineHeight: 1.6 }}>
              Creates a real order flagged <strong>[TEST]</strong> for the chosen distributor and fires the full pipeline on payment
              (real MYOB invoice, real supplier PO email, real freight). Use a test distributor + cheap items, and void the MYOB docs afterwards.
            </p>

            {!result ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Distributor</span>
                  <select style={inp} value={distId} onChange={e => setDistId(e.target.value)}>
                    <option value="">— select distributor —</option>
                    {dists.map(d => <option key={d.id} value={d.id}>{d.display_name}{d.primary_contact_email ? '' : ' (no email)'}</option>)}
                  </select>
                  {distId && !distEmail && <span style={{ fontSize: 11, color: T.amber }}>This distributor has no primary contact email — confirmation/invoice emails will be skipped.</span>}
                </label>

                <div style={{ position: 'relative' }}>
                  <span style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add items</span>
                  <input style={{ ...inp, width: '100%', marginTop: 6 }} value={q} onChange={e => setQ(e.target.value)} placeholder="Search SKU or name…" />
                  {matches.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 8, marginTop: 2, maxHeight: 240, overflowY: 'auto' }}>
                      {matches.map(c => (
                        <div key={c.id} onMouseDown={() => addLine(c)} style={{ padding: '8px 11px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${T.border}` }}>
                          <div>{c.name}</div>
                          <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>{c.sku} · ${Number(c.trade_price_ex_gst || 0).toFixed(2)} ex</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {lines.length > 0 && (
                  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                    {lines.map(l => (
                      <div key={l.cat.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 30px', gap: 8, alignItems: 'center', padding: '8px 10px', borderBottom: `1px solid ${T.border}` }}>
                        <div><div style={{ fontSize: 13 }}>{l.cat.name}</div><div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{l.cat.sku}</div></div>
                        <input type="number" min={1} value={l.qty} onChange={e => setQty(l.cat.id, parseInt(e.target.value, 10) || 1)} style={{ ...inp, padding: '5px 7px' }} />
                        <div style={{ fontSize: 12, fontFamily: 'monospace', color: T.text2, textAlign: 'right' }}>${((Number(l.cat.trade_price_ex_gst) || 0) * l.qty).toFixed(2)}</div>
                        <button onClick={() => remove(l.cat.id)} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16 }}>×</button>
                      </div>
                    ))}
                    <div style={{ padding: '8px 10px', textAlign: 'right', fontSize: 13, color: T.text2 }}>Subtotal ex GST: <strong style={{ color: T.text }}>${total.toFixed(2)}</strong></div>
                  </div>
                )}

                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer PO (optional)</span>
                  <input style={inp} value={po} onChange={e => setPo(e.target.value)} placeholder="TEST-PO-001" maxLength={20} />
                </label>

                {msg && <div style={{ fontSize: 12, color: T.red }}>{msg}</div>}
                <button onClick={create} disabled={!distId || lines.length === 0 || creating} style={btn(T.blue, !!distId && lines.length > 0 && !creating)}>
                  {creating ? 'Creating…' : 'Create test order'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 14 }}>Test order <strong>{result.orderNumber}</strong> created — <a href={`/admin/b2b/orders/${result.orderId}`} style={{ color: T.blue }}>open in admin</a>. Total ${result.total_inc.toFixed(2)} inc GST.</div>
                <div style={{ fontSize: 12.5, color: T.text2 }}>Complete payment to fire the pipeline (MYOB invoice, drop-ship PO + supplier email, admin + distributor emails):</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {result.checkoutUrl && <a href={result.checkoutUrl} target="_blank" rel="noreferrer" style={{ ...btn(T.teal), textDecoration: 'none', display: 'inline-block' }}>Open Stripe test checkout ↗</a>}
                  <button onClick={markPaid} disabled={markState === 'busy' || markState === 'done'} style={btn(T.green, markState !== 'busy' && markState !== 'done')}>
                    {markState === 'busy' ? 'Running pipeline…' : markState === 'done' ? '✓ Marked paid — pipeline ran' : 'Mark paid now (run pipeline)'}
                  </button>
                </div>
                {markState === 'done' && <div style={{ fontSize: 12, color: T.green }}>Pipeline fired. Check the order, MYOB, and your inbox(es).</div>}
                {msg && <div style={{ fontSize: 12, color: T.red }}>{msg}</div>}
                <button onClick={() => { setResult(null); setLines([]); setPo(''); setMarkState('idle') }} style={{ ...btn(T.bg4), alignSelf: 'flex-start', color: T.text2 }}>Create another</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}

// pages/admin/b2b/freight-quote.tsx
// Admin freight calculator (Chris 2026-08-27): add products, type a suburb and
// postcode, get a LIVE MachShip price — with the packing behind it.
//
// This existed only as a panel buried in the test-order builder, which meant
// pricing a job you had no intention of ordering involved a screen for creating
// orders. Same backend (/api/b2b/admin/freight-quote), no order is created,
// nothing is written.
//
// The plan is shown as well as the price because the two are inseparable: a
// quote now compares several packings (all pallets / bulky-on-a-pallet with the
// boxes as parcels / all parcels) and takes whichever the carrier prices
// cheapest, so "why is it that much" is answered by the boxes, not the number.

import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { T, alpha } from '../../../lib/ui/theme'
import { A, RADIUS, cardStyle, PageTitle } from '../../../components/b2b/ui'

interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }
interface Dist { id: string; display_name: string; ship_suburb?: string | null; ship_postcode?: string | null; is_active: boolean }
interface Cat { id: string; sku: string; name: string }
interface Line { cat: Cat; qty: number }
interface PackContent { sku: string; name: string; qty: number }
interface PackBox { name: string; ownPackaging?: boolean; weight_g: number; length_mm: number; width_mm: number; height_mm: number; contents?: PackContent[] }
interface PackUnit { itemType: string; name: string; ownPackaging?: boolean; quantity: number; weight_g: number; length_mm: number; width_mm: number; height_mm: number; contents?: PackContent[]; boxes?: PackBox[] }
interface Rate {
  id: string; label: string; price_ex_gst: number; transit_days: number | null
  source: 'machship' | 'static' | 'satchel' | 'dropship'
  base_price_ex_gst?: number; markup_pct?: number; eta_utc?: string | null
  pack_label?: string; pack_key?: string; pack_units?: PackUnit[]
}
interface Result {
  mode: 'live' | 'static' | 'blocked' | 'no_zone'
  postcode: string; suburb: string | null
  rates: Rate[]
  blocked?: { reason: string; missing: Array<{ sku: string; name: string; missing_fields: string[] }> }
  zone?: { id: string; name: string } | null
  unavailable_reason?: string
}

const inp: React.CSSProperties = { padding: '9px 12px', background: T.bg3, border: '1px solid transparent', borderRadius: RADIUS.sm, color: T.text, fontSize: 13.5, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', minHeight: 38 }
const btn = (bg: string, on = true): React.CSSProperties => ({ padding: '10px 18px', borderRadius: RADIUS.pill, border: '1px solid transparent', background: on ? bg : T.bg3, color: on ? '#fff' : T.text3, fontSize: 13.5, fontWeight: 600, cursor: on ? 'pointer' : 'default', fontFamily: 'inherit', minHeight: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap' })
const lbl: React.CSSProperties = { fontSize: 12.5, fontWeight: 650, color: T.text2 }
const mm = (n: number) => Math.round(n)
const kg = (g: number) => (g / 1000).toFixed(1)

export default function FreightQuotePage({ user }: Props) {
  const [dists, setDists] = useState<Dist[]>([])
  const [cats, setCats] = useState<Cat[]>([])
  const [distId, setDistId] = useState('')
  const [q, setQ] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [suburb, setSuburb] = useState('')
  const [postcode, setPostcode] = useState('')
  const [packMode, setPackMode] = useState<'auto' | 'cartons' | 'pallet'>('auto')
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [openPlan, setOpenPlan] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/b2b/admin/distributors').then(r => r.json()).then(d => setDists((d.items || []).filter((x: Dist) => x.is_active))).catch(() => {})
    fetch('/api/b2b/admin/catalogue').then(r => r.json()).then(d => setCats(d.items || [])).catch(() => {})
  }, [])

  // Picking a distributor fills the destination from their ship address, but
  // leaves it editable — quoting "what would this cost to Perth" is the point.
  function chooseDist(id: string) {
    setDistId(id); setRes(null)
    const d = dists.find(x => x.id === id)
    if (d) { setSuburb(d.ship_suburb || ''); setPostcode(d.ship_postcode || '') }
  }

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    return cats.filter(c => (c.sku || '').toLowerCase().includes(needle) || (c.name || '').toLowerCase().includes(needle)).slice(0, 8)
  }, [q, cats])

  function addLine(cat: Cat) {
    setRes(null); setQ('')
    setLines(ls => ls.some(l => l.cat.id === cat.id) ? ls.map(l => l.cat.id === cat.id ? { ...l, qty: l.qty + 1 } : l) : [...ls, { cat, qty: 1 }])
  }
  function setQty(id: string, qty: number) {
    setRes(null)
    setLines(ls => qty <= 0 ? ls.filter(l => l.cat.id !== id) : ls.map(l => l.cat.id === id ? { ...l, qty } : l))
  }

  async function quote() {
    if (lines.length === 0) { setMsg('Add at least one product.'); return }
    if (!postcode.trim()) { setMsg('A postcode is required.'); return }
    setBusy(true); setMsg(''); setRes(null); setOpenPlan(null)
    try {
      const r = await fetch('/api/b2b/admin/freight-quote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          distributorId: distId || undefined, suburb: suburb.trim() || undefined, postcode: postcode.trim(),
          packMode, items: lines.map(l => ({ catalogueId: l.cat.id, qty: l.qty })),
        }),
      })
      const d = await r.json()
      if (!r.ok) { setMsg(d.error || 'Quote failed'); return }
      setRes(d)
    } catch (e: any) { setMsg(e?.message || 'Quote failed') } finally { setBusy(false) }
  }

  return (
    <>
      <Head><title>Freight quote — JA Portal</title></Head>
      <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 20 }}>
        <B2BAdminTabs active="freight" />
        <PageTitle sub="Live MachShip rates for any basket to any destination, with the packing behind the price. Nothing is ordered and nothing is saved.">
          Freight quote
        </PageTitle>

        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* ── Products ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={lbl}>Products</span>
            <input style={inp} value={q} onChange={e => setQ(e.target.value)} placeholder="Search the catalogue by SKU or name…" />
            {matches.length > 0 && (
              <div style={{ border: `1px solid ${T.border}`, borderRadius: RADIUS.sm, overflow: 'hidden' }}>
                {matches.map(c => (
                  <div key={c.id} onClick={() => addLine(c)} className="al-press" style={{ padding: '8px 10px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${T.border}` }}>
                    <span style={{ fontFamily: 'monospace', color: T.text3, marginRight: 8 }}>{c.sku}</span>{c.name}
                  </div>
                ))}
              </div>
            )}
            {lines.length === 0
              ? <div style={{ fontSize: 12.5, color: T.text3 }}>No products yet.</div>
              : lines.map(l => (
                <div key={l.cat.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: `1px dashed ${T.border}` }}>
                  <input type="number" min={0} value={l.qty} onChange={e => setQty(l.cat.id, Number(e.target.value))} style={{ ...inp, width: 76, minHeight: 32, padding: '5px 8px' }} />
                  <span style={{ fontSize: 13, flex: 1 }}>
                    <span style={{ fontFamily: 'monospace', color: T.text3, marginRight: 8 }}>{l.cat.sku}</span>{l.cat.name}
                  </span>
                  <button onClick={() => setQty(l.cat.id, 0)} className="al-press al-ghost" style={{ ...btn(T.bg3), padding: '4px 12px', minHeight: 30, color: T.text2 }}>Remove</button>
                </div>
              ))}
          </div>

          {/* ── Destination ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: T.text3 }}>Distributor (optional — fills the address)</span>
              <select value={distId} onChange={e => chooseDist(e.target.value)} style={inp}>
                <option value="">—</option>
                {dists.map(d => <option key={d.id} value={d.id}>{d.display_name}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: T.text3 }}>Suburb</span>
              <input style={inp} value={suburb} onChange={e => { setSuburb(e.target.value); setRes(null) }} placeholder="e.g. Kenwick" />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: T.text3 }}>Postcode</span>
              <input style={inp} value={postcode} onChange={e => { setPostcode(e.target.value); setRes(null) }} placeholder="e.g. 6107" maxLength={4} />
            </label>
            <button onClick={quote} disabled={busy} className="al-press al-focus al-primary" style={btn(A.accent, !busy)}>{busy ? 'Quoting…' : 'Quote freight'}</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: T.text3 }}>Pack as</span>
            <select value={packMode} onChange={e => { setPackMode(e.target.value as any); setRes(null) }} style={{ ...inp, width: 'auto', padding: '6px 8px', minHeight: 32 }}>
              <option value="auto">Auto — price every packing, take the cheapest</option>
              <option value="cartons">Cartons only</option>
              <option value="pallet">Pallets only</option>
            </select>
          </div>

          {msg && <div style={{ fontSize: 12.5, color: A.bad }}>{msg}</div>}

          {/* ── Result ── */}
          {res && (
            res.mode === 'blocked' ? (
              <div style={{ fontSize: 12.5, color: A.warn }}>
                {res.blocked?.reason}
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {(res.blocked?.missing || []).map(m => (
                    <li key={m.sku} style={{ color: T.text2 }}>{m.name} <span style={{ fontFamily: 'monospace', color: T.text3 }}>({m.sku})</span> — missing {m.missing_fields.join(', ')}</li>
                  ))}
                </ul>
                <div style={{ marginTop: 6, color: T.text3 }}>Fix the dimensions on the catalogue page, then re-quote.</div>
              </div>
            ) : res.rates.length === 0 ? (
              <div style={{ fontSize: 12.5, color: A.warn }}>No rates for {res.postcode}{res.unavailable_reason ? ` — ${res.unavailable_reason}` : ''}.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: T.text3 }}>
                  To {res.suburb ? `${res.suburb} ` : ''}{res.postcode} · {res.mode === 'live' ? 'live MachShip' : res.mode === 'static' ? `static zone${res.zone ? ` (${res.zone.name})` : ''}` : res.mode}
                  {res.mode === 'static' && res.unavailable_reason ? ` — live unavailable: ${res.unavailable_reason}` : ''}
                </div>
                {res.rates.map((r, i) => {
                  const open = openPlan === r.id
                  const units = r.pack_units || []
                  return (
                    <div key={r.id} style={{ background: T.bg3, borderRadius: RADIUS.sm, padding: '8px 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        <div>
                          <span style={{ fontSize: 13 }}>{r.label}</span>
                          {i === 0 && <span style={{ fontSize: 12, color: A.good, marginLeft: 6 }}>cheapest</span>}
                          {r.transit_days != null && <span style={{ fontSize: 12, color: T.text3, marginLeft: 6 }}>~{r.transit_days}d</span>}
                          {r.pack_label && <div style={{ fontSize: 12, color: T.text3 }}>packed as: {r.pack_label}</div>}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontSize: 14, fontFamily: 'monospace', fontWeight: 700 }}>${r.price_ex_gst.toFixed(2)}</span>
                          <span style={{ fontSize: 12, color: T.text3 }}> ex GST</span>
                          {r.base_price_ex_gst != null && r.markup_pct != null && r.markup_pct > 0 && (
                            <div style={{ fontSize: 12, color: T.text3 }}>carrier ${r.base_price_ex_gst.toFixed(2)} + {r.markup_pct}%</div>
                          )}
                        </div>
                      </div>
                      {units.length > 0 && (
                        <>
                          <button onClick={() => setOpenPlan(open ? null : r.id)} className="al-press al-ghost"
                            style={{ ...btn(T.bg3), padding: '3px 10px', minHeight: 26, color: T.text2, marginTop: 6, fontSize: 12 }}>
                            {open ? 'Hide' : 'Show'} the {units.length} consignment{units.length === 1 ? '' : 's'}
                          </button>
                          {open && (
                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {units.map((u, ui) => (
                                <div key={ui} style={{ border: `1px solid ${T.border}`, borderRadius: RADIUS.sm, padding: '6px 10px' }}>
                                  <div style={{ fontSize: 12.5, fontWeight: 650 }}>
                                    {u.quantity > 1 ? `${u.quantity} × ` : ''}{u.itemType === 'Pallet' ? (u.name || 'Pallet') : (u.ownPackaging ? `${u.name} (own packaging)` : u.name)}
                                    <span style={{ fontWeight: 400, color: T.text3 }}> — {mm(u.length_mm)}×{mm(u.width_mm)}×{mm(u.height_mm)} mm · {kg(u.weight_g)} kg</span>
                                  </div>
                                  {(u.boxes || []).length > 0 ? (
                                    <div style={{ fontSize: 12, color: T.text2, marginTop: 3 }}>
                                      {(u.boxes || []).length} {(u.boxes || []).length === 1 ? 'box' : 'boxes'} on this pallet:
                                      {(u.boxes || []).map((b, bi) => (
                                        <div key={bi} style={{ paddingLeft: 10 }}>
                                          {b.ownPackaging ? `${b.name} (own packaging)` : b.name} — {(b.contents || []).map(cl => `${cl.qty}× ${cl.name}`).join(' · ')}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (u.contents || []).length > 0 ? (
                                    <div style={{ fontSize: 12, color: T.text2, marginTop: 3 }}>
                                      {(u.contents || []).map(cl => `${cl.qty}× ${cl.name}`).join(' · ')}
                                    </div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
                <div style={{ fontSize: 12, color: T.text3, marginTop: 4, background: alpha(A.accent, '14'), padding: '6px 10px', borderRadius: RADIUS.sm }}>
                  On <strong>Auto</strong> each carrier is priced on every sensible packing — all pallets, the bulky items on a pallet with the boxes as parcels, and all parcels — and shown at its cheapest. The packing named under each rate is the one that price belongs to, and it is what would be booked and printed.
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}

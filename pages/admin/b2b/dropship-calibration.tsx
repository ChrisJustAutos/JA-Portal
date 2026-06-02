// pages/admin/b2b/dropship-calibration.tsx
// Derive drop-ship freight rates from a supplier's real MYOB purchase history.
// Pulls the supplier's bills, maps each delivery postcode → zone and reads the
// freight charged, then proposes a per-product × per-zone rate (MAX seen, the
// "never under-recover" figure). Review/edit the matrix, then apply.

import { useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e',
}

interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }

// Relative road-freight cost from a WA (Perth) origin — Perth = 1.0, rising with
// distance. Used to estimate a gap zone from the zones we DO have data for:
// est(gap) = mean over known zones of rate[k] × index[gap] / index[k].
// Rough but directionally right (MPI dispatches from WA); always editable.
const WA_FREIGHT_INDEX: Record<string, number> = {
  'Perth Metro': 1.0, 'WA Regional': 1.6,
  'Adelaide Metro': 2.0, 'SA Regional': 2.4,
  'Northern Territory': 2.8,
  'Melbourne Metro': 2.6, 'VIC Regional': 3.0,
  'Sydney Metro': 2.9, 'NSW Regional': 3.3, 'ACT (Canberra)': 3.0,
  'Brisbane Metro (SEQ)': 3.2, 'QLD Regional': 3.6,
  'Tasmania': 3.4,
  'Remote & Outback': 4.0,
}
function waIndex(zoneName: string): number | null {
  if (WA_FREIGHT_INDEX[zoneName] != null) return WA_FREIGHT_INDEX[zoneName]
  const lc = zoneName.toLowerCase()
  for (const [k, v] of Object.entries(WA_FREIGHT_INDEX)) if (k.toLowerCase() === lc) return v
  return null
}

interface Cell { max: number; count: number }
interface ApiData {
  supplier: { uid: string; name: string } | null
  markupPercent: number
  totals: { billsFetched: number; withFreight: number; withPostcode: number; withZone: number; singleProduct: number; multiProduct: number; noProductMatch: number }
  zones: { id: string; name: string }[]
  products: { catalogue_id: string; sku: string; name: string }[]
  rows: any[]
  perProductZone: Record<string, Record<string, Cell>>
  perZone: Record<string, Cell>
}

export default function DropshipCalibrationPage({ user }: Props) {
  const [supplierName, setSupplierName] = useState('MPI')
  const [sinceMonths, setSinceMonths] = useState('24')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ApiData | null>(null)
  const [error, setError] = useState<string | null>(null)
  // edits keyed `${catalogueId}|${zoneId}` → string price (ex GST)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [zoneDefaults, setZoneDefaults] = useState<Record<string, string>>({})
  const [markupPct, setMarkupPct] = useState('20')
  const [applying, setApplying] = useState(false)
  const [flash, setFlash] = useState('')

  async function pull() {
    setLoading(true); setError(null); setData(null)
    try {
      const r = await fetch(`/api/b2b/admin/dropship-calibration?supplierName=${encodeURIComponent(supplierName)}&sinceMonths=${encodeURIComponent(sinceMonths)}`)
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      setData(j)
      if (j.markupPercent != null) setMarkupPct(String(j.markupPercent))
      // The API returns freight ex-GST; show inc-GST (matches supplier invoices).
      const inc = (v: number) => String(Math.round(v * 1.1 * 100) / 100)
      // Prefill: product-level max where we have it, else the zone fallback max.
      const e: Record<string, string> = {}
      for (const p of j.products as ApiData['products']) {
        for (const z of j.zones as ApiData['zones']) {
          const pv = j.perProductZone?.[p.catalogue_id]?.[z.id]?.max
          const zv = j.perZone?.[z.id]?.max
          const v = pv != null ? pv : (zv != null ? zv : null)
          if (v != null) e[`${p.catalogue_id}|${z.id}`] = inc(v)
        }
      }
      setEdits(e)
      // Zone defaults: prefilled from the zone-wide max where there's history,
      // blank where the zone has never been shipped to (fill from MPI's chart).
      const zd: Record<string, string> = {}
      for (const z of j.zones as ApiData['zones']) {
        const v = j.perZone?.[z.id]?.max
        if (v != null) zd[z.id] = inc(v)
      }
      setZoneDefaults(zd)
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setLoading(false) }
  }

  // Estimate the zone-default for any zone WITHOUT a rate (scaled by distance-from-WA,
  // since MPI dispatches from WA), THEN fill every empty product cell from those
  // defaults — one click fills the whole matrix.
  function autoEstimate() {
    if (!data) return
    const known = data.zones
      .map(z => ({ rate: Number(zoneDefaults[z.id]), index: waIndex(z.name) }))
      .filter(k => Number.isFinite(k.rate) && k.rate > 0 && k.index != null) as { rate: number; index: number }[]
    if (known.length === 0) {
      setFlash('Add at least one zone rate first (pull history, or type one in the blue row), then auto-estimate.')
      return
    }
    // 1) Estimate gap zone defaults.
    const nextZD: Record<string, string> = { ...zoneDefaults }
    let estimated = 0
    for (const z of data.zones) {
      if (nextZD[z.id] != null && nextZD[z.id].trim() !== '') continue
      const gi = waIndex(z.name); if (gi == null) continue
      const est = known.reduce((s, k) => s + k.rate * (gi / k.index), 0) / known.length
      nextZD[z.id] = String(Math.round(est * 2) / 2)   // nearest $0.50
      estimated++
    }
    // 2) Fill empty product cells from the (now complete) zone defaults.
    const nextEdits: Record<string, string> = { ...edits }
    let filled = 0
    for (const p of data.products) for (const z of data.zones) {
      const key = `${p.catalogue_id}|${z.id}`
      const def = nextZD[z.id]
      if ((nextEdits[key] == null || nextEdits[key] === '') && def != null && def.trim() !== '') { nextEdits[key] = def; filled++ }
    }
    setZoneDefaults(nextZD)
    setEdits(nextEdits)
    setFlash(`Estimated ${estimated} zone${estimated === 1 ? '' : 's'} (MPI in WA) · filled ${filled} cell${filled === 1 ? '' : 's'}.`)
  }

  // Fill any empty product×zone cell with that zone's default figure.
  function fillEmpty() {
    if (!data) return
    const next: Record<string, string> = { ...edits }
    let filled = 0
    for (const p of data.products) for (const z of data.zones) {
      const key = `${p.catalogue_id}|${z.id}`
      const def = zoneDefaults[z.id]
      if ((next[key] == null || next[key] === '') && def != null && def.trim() !== '') { next[key] = def; filled++ }
    }
    setEdits(next)
    setFlash(`Filled ${filled} empty cell${filled === 1 ? '' : 's'} from zone defaults.`)
  }

  async function apply() {
    if (!data) return
    setApplying(true); setFlash('')
    let ok = 0, fail = 0
    for (const p of data.products) {
      // Matrix shows MPI's COST inc-GST. Bill = cost × markup; store ex-GST (÷1.1).
      const markMul = 1 + (Number(markupPct) || 0) / 100
      const rates: Record<string, any> = {}
      for (const z of data.zones) {
        const v = edits[`${p.catalogue_id}|${z.id}`]
        if (v != null && v.trim() !== '') rates[z.id] = Math.round((Number(v) * markMul / 1.1) * 100) / 100
      }
      if (Object.keys(rates).length === 0) continue
      try {
        const r = await fetch(`/api/b2b/admin/catalogue/${p.catalogue_id}/dropship-freight`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rates }),
        })
        if (r.ok) ok++; else fail++
      } catch { fail++ }
    }
    setApplying(false)
    setFlash(`Applied to ${ok} product${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}.`)
  }

  const card: React.CSSProperties = { background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }
  const inp: React.CSSProperties = { padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }

  return (
    <>
      <Head><title>Drop-ship freight calibration — B2B Admin</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, padding: 20 }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <B2BAdminTabs active="orders" />
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '18px 0 6px' }}>Drop-ship freight calibration</h1>
            <p style={{ fontSize: 12.5, color: T.text2, marginTop: 0, lineHeight: 1.6 }}>
              Pulls a supplier&rsquo;s MYOB bills, maps each delivery postcode to a freight zone and reads the freight charged, then
              proposes a <strong>per-product × per-zone</strong> rate (the <strong>max</strong> seen, so you never under-recover).
              Cells show MPI&rsquo;s <strong>cost inc-GST</strong> (matching their invoices); on Apply the customer is billed <strong>cost × markup</strong>.
            </p>

            {/* Controls */}
            <div style={{ ...card, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: T.text3 }}>
                Supplier (name search)
                <input style={{ ...inp, width: 160 }} value={supplierName} onChange={e => setSupplierName(e.target.value)} placeholder="MPI" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: T.text3 }}>
                History (months)
                <input style={{ ...inp, width: 100 }} inputMode="numeric" value={sinceMonths} onChange={e => setSinceMonths(e.target.value)} />
              </label>
              <button onClick={pull} disabled={loading} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: T.blue, color: '#fff', fontSize: 13, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                {loading ? 'Pulling…' : 'Pull purchase history'}
              </button>
              {error && <span style={{ fontSize: 12, color: T.red }}>{error}</span>}
            </div>

            {data && (
              <>
                {/* Coverage */}
                <div style={{ ...card, marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
                    {data.supplier ? <>Supplier: <span style={{ color: T.teal }}>{data.supplier.name}</span></> : 'Supplier not found'}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
                    {([
                      ['Bills found', data.totals.billsFetched, T.text],
                      ['With freight $', data.totals.withFreight, T.green],
                      ['With postcode', data.totals.withPostcode, data.totals.withPostcode ? T.green : T.amber],
                      ['Mapped to zone', data.totals.withZone, data.totals.withZone ? T.green : T.amber],
                      ['Single-product', data.totals.singleProduct, T.text],
                      ['Multi-product', data.totals.multiProduct, T.text3],
                      ['No product match', data.totals.noProductMatch, T.text3],
                    ] as [string, number, string][]).map(([label, val, col]) => (
                      <div key={label} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: col }}>{val}</div>
                        <div style={{ fontSize: 10.5, color: T.text3 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {data.totals.withPostcode === 0 && (
                    <div style={{ fontSize: 12, color: T.amber, marginTop: 10, lineHeight: 1.5 }}>
                      ⚠ None of these bills carry a delivery postcode in their Ship-to address, so they can&rsquo;t be mapped to a zone.
                      The freight + customer address may live on the drop-ship purchase <em>orders</em> instead — tell me and I&rsquo;ll pull those.
                    </div>
                  )}
                </div>

                {/* Matrix */}
                {data.products.length > 0 && data.totals.withZone > 0 ? (
                  <div style={{ ...card, overflowX: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12 }}>
                      <div style={{ fontSize: 12, color: T.text2 }}>
                        Cells show MPI&rsquo;s <strong>cost (inc GST)</strong>. <span style={{ color: T.amber }}>Amber</span> = zone-wide estimate (no per-product data). Customer is billed <strong>cost × markup</strong> on Apply.
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: T.text3 }}>
                          Markup %
                          <input inputMode="decimal" value={markupPct} onChange={e => setMarkupPct(e.target.value)} style={{ width: 56, padding: '6px 7px', textAlign: 'right', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 5, color: T.text, fontSize: 12.5, fontFamily: 'inherit', outline: 'none' }} />
                        </label>
                        {flash && <span style={{ fontSize: 12, color: T.green }}>{flash}</span>}
                        <button onClick={autoEstimate} title="Estimate empty zone defaults from the zones you have, scaled by distance from WA" style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${T.border2}`, background: 'transparent', color: T.teal, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Auto-estimate gaps (MPI in WA)
                        </button>
                        <button onClick={fillEmpty} style={{ padding: '8px 14px', borderRadius: 7, border: `1px solid ${T.border2}`, background: 'transparent', color: T.blue, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Fill empty cells from zone defaults
                        </button>
                        <button onClick={apply} disabled={applying} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: T.green, color: '#06210f', fontSize: 13, fontWeight: 700, cursor: applying ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
                          {applying ? 'Applying…' : `Apply to drop-ship rates (cost +${Number(markupPct) || 0}%)`}
                        </button>
                      </div>
                    </div>
                    <table style={{ borderCollapse: 'collapse', fontSize: 12, minWidth: 700 }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: 'left', padding: '6px 8px', position: 'sticky', left: 0, background: T.bg2, color: T.text3, fontWeight: 600, fontSize: 10.5 }}>Product</th>
                          {data.zones.map(z => (
                            <th key={z.id} style={{ padding: '6px 6px', color: T.text3, fontWeight: 600, fontSize: 10, whiteSpace: 'nowrap' }}>{z.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Zone default row — type MPI's chart figure for gap zones, then "Fill empty cells". */}
                        <tr style={{ borderTop: `1px solid ${T.border}`, background: `${T.blue}0d` }}>
                          <td style={{ padding: '5px 8px', position: 'sticky', left: 0, background: T.bg2, whiteSpace: 'nowrap', fontSize: 11, color: T.blue, fontWeight: 600 }} title="Per-zone default — fills empty product cells">Zone default →</td>
                          {data.zones.map(z => (
                            <td key={z.id} style={{ padding: '3px 4px' }}>
                              <input
                                inputMode="decimal" placeholder="—" value={zoneDefaults[z.id] ?? ''}
                                onChange={e => setZoneDefaults(s => ({ ...s, [z.id]: e.target.value }))}
                                style={{ width: 64, padding: '4px 5px', textAlign: 'right', background: T.bg3, border: `1px solid ${T.blue}55`, borderRadius: 4, color: T.blue, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', outline: 'none' }}
                              />
                            </td>
                          ))}
                        </tr>
                        {data.products.map(p => (
                          <tr key={p.catalogue_id} style={{ borderTop: `1px solid ${T.border}` }}>
                            <td style={{ padding: '5px 8px', position: 'sticky', left: 0, background: T.bg2, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.name}>
                              <span style={{ color: T.text }}>{p.name}</span> <span style={{ color: T.text3, fontSize: 10 }}>{p.sku}</span>
                            </td>
                            {data.zones.map(z => {
                              const key = `${p.catalogue_id}|${z.id}`
                              const hasProductData = data.perProductZone?.[p.catalogue_id]?.[z.id] != null
                              const isFallback = !hasProductData && edits[key] != null && edits[key] !== ''
                              return (
                                <td key={z.id} style={{ padding: '3px 4px' }}>
                                  <input
                                    inputMode="decimal" value={edits[key] ?? ''}
                                    onChange={e => setEdits(s => ({ ...s, [key]: e.target.value }))}
                                    style={{ width: 64, padding: '4px 5px', textAlign: 'right', background: T.bg3, border: `1px solid ${isFallback ? T.amber + '66' : T.border2}`, borderRadius: 4, color: isFallback ? T.amber : T.text, fontSize: 11.5, fontFamily: 'inherit', outline: 'none' }}
                                    title={hasProductData ? `${data.perProductZone[p.catalogue_id][z.id].count} bill(s)` : (data.perZone?.[z.id] ? `zone estimate from ${data.perZone[z.id].count} bill(s)` : 'no data')}
                                  />
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : data.totals.withZone > 0 ? (
                  <div style={{ ...card, fontSize: 12.5, color: T.text2 }}>
                    Freight + zones were found, but no bill lines mapped to a drop-ship catalogue product (matched by MYOB item). Flag the products as &ldquo;Drop ship&rdquo; in the catalogue and make sure their MYOB item link is set, then pull again.
                  </div>
                ) : null}
              </>
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

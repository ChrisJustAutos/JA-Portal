// components/b2b/DropshipCalibrationPanel.tsx
// Drop-ship freight calibration UI (controls + coverage + product×zone matrix).
// Shared by the standalone page (/admin/b2b/dropship-calibration) and the modal
// launched from the catalogue drop-ship freight editor.
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useState } from 'react'
import { T, alpha } from '../../lib/ui/theme'
import { A, Btn, btnStyle, cardStyle, inputStyle, RADIUS } from './ui'

// Relative road-freight cost from a WA (Perth) origin — Perth = 1.0, rising with
// distance. Estimates a gap zone from the zones we DO have data for:
// est(gap) = mean over known zones of rate[k] × index[gap] / index[k].
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

export default function DropshipCalibrationPanel() {
  const [supplierName, setSupplierName] = useState('MPI')
  const [sinceMonths, setSinceMonths] = useState('24')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<ApiData | null>(null)
  const [error, setError] = useState<string | null>(null)
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
      const inc = (v: number) => String(Math.round(v * 1.1 * 100) / 100)
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
      const zd: Record<string, string> = {}
      for (const z of j.zones as ApiData['zones']) {
        const v = j.perZone?.[z.id]?.max
        if (v != null) zd[z.id] = inc(v)
      }
      setZoneDefaults(zd)
    } catch (e: any) { setError(e?.message || String(e)) }
    finally { setLoading(false) }
  }

  function autoEstimate() {
    if (!data) return
    const known = data.zones
      .map(z => ({ rate: Number(zoneDefaults[z.id]), index: waIndex(z.name) }))
      .filter(k => Number.isFinite(k.rate) && k.rate > 0 && k.index != null) as { rate: number; index: number }[]
    if (known.length === 0) {
      setFlash('Add at least one zone rate first (pull history, or type one in the blue row), then auto-estimate.')
      return
    }
    const nextZD: Record<string, string> = { ...zoneDefaults }
    let estimated = 0
    for (const z of data.zones) {
      if (nextZD[z.id] != null && nextZD[z.id].trim() !== '') continue
      const gi = waIndex(z.name); if (gi == null) continue
      const est = known.reduce((s, k) => s + k.rate * (gi / k.index), 0) / known.length
      nextZD[z.id] = String(Math.round(est * 2) / 2)
      estimated++
    }
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

  const card: React.CSSProperties = cardStyle(18)
  // Dense control inputs — kit look scaled for the toolbar (floor is 12px type).
  const inp: React.CSSProperties = { ...inputStyle(), padding: '8px 11px', fontSize: 13, minHeight: 38, width: 'auto' }
  // Matrix cell inputs stay tight so the table keeps its density.
  const cellInp: React.CSSProperties = {
    width: 64, padding: '4px 6px', textAlign: 'right', background: T.bg3,
    borderRadius: 6, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
  }

  return (
    <div>
      <p style={{ fontSize: 12.5, color: T.text2, marginTop: 0, lineHeight: 1.6 }}>
        Pulls a supplier&rsquo;s MYOB bills, maps each delivery postcode to a freight zone and reads the freight charged, then
        proposes a <strong>per-product × per-zone</strong> rate (the <strong>max</strong> seen, so you never under-recover).
        Cells show MPI&rsquo;s <strong>cost inc-GST</strong> (matching their invoices); on Apply the customer is billed <strong>cost × markup</strong>.
      </p>

      {/* Controls */}
      <div style={{ ...card, display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 650, color: T.text2 }}>
          Supplier (name search)
          <input style={{ ...inp, width: 160 }} value={supplierName} onChange={e => setSupplierName(e.target.value)} placeholder="MPI" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 650, color: T.text2 }}>
          History (months)
          <input style={{ ...inp, width: 100 }} inputMode="numeric" value={sinceMonths} onChange={e => setSinceMonths(e.target.value)} />
        </label>
        <Btn onClick={pull} disabled={loading}>
          {loading ? 'Pulling…' : 'Pull purchase history'}
        </Btn>
        {error && <span style={{ fontSize: 12.5, color: A.bad }}>{error}</span>}
      </div>

      {data && (
        <>
          {/* Coverage */}
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 10 }}>
              {data.supplier ? <>Supplier: <span style={{ color: A.accent }}>{data.supplier.name}</span></> : 'Supplier not found'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10 }}>
              {([
                ['Bills found', data.totals.billsFetched, T.text],
                ['With freight $', data.totals.withFreight, A.good],
                ['With postcode', data.totals.withPostcode, data.totals.withPostcode ? A.good : A.warn],
                ['Mapped to zone', data.totals.withZone, data.totals.withZone ? A.good : A.warn],
                ['Single-product', data.totals.singleProduct, T.text],
                ['Multi-product', data.totals.multiProduct, T.text3],
                ['No product match', data.totals.noProductMatch, T.text3],
              ] as [string, number, string][]).map(([label, val, col]) => (
                <div key={label} style={{ background: T.bg3, borderRadius: RADIUS.sm, padding: '8px 10px' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: col, fontVariantNumeric: 'tabular-nums' }}>{val}</div>
                  <div style={{ fontSize: 12, color: T.text3 }}>{label}</div>
                </div>
              ))}
            </div>
            {data.totals.withPostcode === 0 && (
              <div style={{ fontSize: 12.5, color: A.warn, marginTop: 10, lineHeight: 1.5 }}>
                ⚠ None of these bills carry a delivery postcode in their Ship-to address, so they can&rsquo;t be mapped to a zone.
                The freight + customer address may live on the drop-ship purchase <em>orders</em> instead — tell me and I&rsquo;ll pull those.
              </div>
            )}
          </div>

          {/* Matrix */}
          {data.products.length > 0 && data.totals.withZone > 0 ? (
            <div style={{ ...card, overflowX: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12.5, color: T.text2, maxWidth: 360 }}>
                  Cells show MPI&rsquo;s <strong>cost (inc GST)</strong>. <span style={{ color: A.warn }}>Amber</span> = zone-wide estimate (no per-product data). Customer is billed <strong>cost × markup</strong> on Apply.
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, color: T.text2 }}>
                    Markup %
                    <input inputMode="decimal" value={markupPct} onChange={e => setMarkupPct(e.target.value)} style={{ ...cellInp, width: 56, fontSize: 12.5 }} />
                  </label>
                  {flash && <span style={{ fontSize: 12.5, color: A.good }}>{flash}</span>}
                  <Btn variant="secondary" size="sm" onClick={autoEstimate} title="Estimate empty zone defaults from the zones you have, scaled by distance from WA">
                    Auto-estimate gaps (MPI in WA)
                  </Btn>
                  <Btn variant="secondary" size="sm" onClick={fillEmpty}>
                    Fill empty cells from zone defaults
                  </Btn>
                  <button onClick={apply} disabled={applying}
                    className="al-press al-focus al-primary"
                    style={{ ...btnStyle('primary', 'sm'), background: applying ? T.bg3 : A.good, color: applying ? T.text3 : '#06210f', cursor: applying ? 'wait' : 'pointer' }}>
                    {applying ? 'Applying…' : `Apply to drop-ship rates (cost +${Number(markupPct) || 0}%)`}
                  </button>
                </div>
              </div>
              <table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: 700 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '6px 8px', position: 'sticky', left: 0, background: T.bg2, color: T.text2, fontWeight: 650, fontSize: 12 }}>Product</th>
                    {data.zones.map(z => (
                      <th key={z.id} style={{ padding: '6px 6px', color: T.text2, fontWeight: 650, fontSize: 12, whiteSpace: 'nowrap' }}>{z.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderTop: `1px solid ${T.border}`, background: alpha(A.accent, '0d') }}>
                    <td style={{ padding: '5px 8px', position: 'sticky', left: 0, background: T.bg2, whiteSpace: 'nowrap', fontSize: 12, color: A.accent, fontWeight: 650 }} title="Per-zone default — fills empty product cells">Zone default →</td>
                    {data.zones.map(z => (
                      <td key={z.id} style={{ padding: '3px 4px' }}>
                        <input
                          inputMode="decimal" placeholder="—" value={zoneDefaults[z.id] ?? ''}
                          onChange={e => setZoneDefaults(s => ({ ...s, [z.id]: e.target.value }))}
                          style={{ ...cellInp, border: `1px solid ${alpha(A.accent, '55')}`, color: A.accent, fontWeight: 600 }}
                        />
                      </td>
                    ))}
                  </tr>
                  {data.products.map(p => (
                    <tr key={p.catalogue_id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: '5px 8px', position: 'sticky', left: 0, background: T.bg2, whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={p.name}>
                        <span style={{ color: T.text }}>{p.name}</span> <span style={{ color: T.text3, fontSize: 12 }}>{p.sku}</span>
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
                              style={{ ...cellInp, border: `1px solid ${isFallback ? alpha(A.warn, '66') : T.border2}`, color: isFallback ? A.warn : T.text }}
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
  )
}

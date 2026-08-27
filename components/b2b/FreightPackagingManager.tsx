// components/b2b/FreightPackagingManager.tsx
// Edit the standard freight cartons + pallet spec + palletise-by-weight
// threshold. Feeds the cartonizer that packs multi-item orders for MachShip.
// Dims are entered in mm; weights in kg (stored as grams).
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'
import { useConfirm } from '../ui/Feedback'
import { A, Btn, inputStyle } from './ui'

// Dense grid input — kit look scaled for the carton/satchel rows (floor 12px).
const inp: React.CSSProperties = { ...inputStyle(), padding: '6px 9px', fontSize: 13, minHeight: 32 }
const kg = (grams: any) => (grams == null ? '' : String(Math.round(Number(grams) / 100) / 10))
const toG = (kgVal: string) => { const n = parseFloat(kgVal); return Number.isFinite(n) ? Math.round(n * 1000) : null }
const toInt = (v: string) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null }
// Dimensions are stored in mm but entered/shown in cm (matches the catalogue page
// + how couriers think). 355mm ↔ 35.5cm.
const cm = (mm: any) => (mm == null || mm === '' ? '' : String(Math.round(Number(mm)) / 10))
const toMm = (cmVal: string) => { const n = parseFloat(cmVal); return Number.isFinite(n) ? Math.round(n * 10) : null }
// Satchel prices are stored EX-GST but entered/shown INC-GST (Chris's call).
const incFromEx = (ex: any) => (ex == null || ex === '' ? '' : String(Math.round(Number(ex) * 1.1 * 100) / 100))
const exFromInc = (inc: string) => { const n = parseFloat(inc); return Number.isFinite(n) ? Math.round((n / 1.1) * 100) / 100 : null }

interface Box { id: string; name: string; length_mm: number; width_mm: number; height_mm: number; max_weight_g: number; sort_order: number; is_active: boolean }
interface Pallet { id: string; name: string; length_mm: number; width_mm: number; max_height_mm: number; max_weight_g: number; sort_order: number; is_active: boolean }
interface Satchel { id: string; name: string; max_weight_g: number; max_length_mm: number | null; max_width_mm: number | null; max_height_mm: number | null; cost_ex_gst: number; sell_ex_gst: number; sort_order: number; is_active: boolean }

export default function FreightPackagingManager() {
  const confirmDialog = useConfirm()
  const [boxes, setBoxes] = useState<Box[]>([])
  const [satchels, setSatchels] = useState<Satchel[]>([])
  const [pallets, setPallets] = useState<Pallet[]>([])
  // Only the palletise-over threshold still lives on settings — it decides
  // pallet vs cartons for the order, not which pallet.
  const [threshold, setThreshold] = useState('')
  const [addingPallet, setAddingPallet] = useState(false)
  const [newPallet, setNewPallet] = useState({ name: '', length_mm: '', width_mm: '', max_height_mm: '', max_weight_kg: '' })
  const [loading, setLoading] = useState(true)
  const [flash, setFlash] = useState('')
  const [savingPallet, setSavingPallet] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addingSat, setAddingSat] = useState(false)
  const [newBox, setNewBox] = useState({ name: '', length_mm: '', width_mm: '', height_mm: '', max_weight_kg: '' })
  const [newSat, setNewSat] = useState({ name: '', length_mm: '', width_mm: '', height_mm: '', max_weight_kg: '', cost_inc: '', sell_inc: '' })

  function flashMsg(m: string) { setFlash(m); setTimeout(() => setFlash(''), 2500) }

  async function load() {
    setLoading(true)
    const [bx, sat, pl, st] = await Promise.all([
      fetch('/api/b2b/admin/freight-boxes').then(r => r.ok ? r.json() : { boxes: [] }),
      fetch('/api/b2b/admin/freight-satchels').then(r => r.ok ? r.json() : { satchels: [] }),
      fetch('/api/b2b/admin/freight-pallets').then(r => r.ok ? r.json() : { pallets: [] }),
      fetch('/api/b2b/admin/settings').then(r => r.ok ? r.json() : null),
    ])
    setPallets(pl.pallets || [])
    setBoxes(bx.boxes || [])
    setSatchels(sat.satchels || [])
    const s = st?.settings || {}
    setThreshold(kg(s.freight_pallet_threshold_g))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function patchBox(id: string, patch: Record<string, any>) {
    const r = await fetch(`/api/b2b/admin/freight-boxes?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) flashMsg('Saved'); else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Save failed') }
  }
  function updateBoxLocal(id: string, p: Partial<Box>) { setBoxes(bs => bs.map(b => b.id === id ? { ...b, ...p } : b)) }

  async function removeBox(id: string, name: string) {
    if (!(await confirmDialog({ title: `Delete box "${name}"?`, danger: true }))) return
    const r = await fetch(`/api/b2b/admin/freight-boxes?id=${id}`, { method: 'DELETE' })
    if (r.ok) { setBoxes(bs => bs.filter(b => b.id !== id)); flashMsg('Deleted') }
  }

  async function addBox() {
    const payload = { name: newBox.name.trim(), length_mm: toMm(newBox.length_mm), width_mm: toMm(newBox.width_mm), height_mm: toMm(newBox.height_mm), max_weight_g: toG(newBox.max_weight_kg) }
    if (!payload.name || !payload.length_mm || !payload.width_mm || !payload.height_mm || !payload.max_weight_g) { flashMsg('Fill all box fields'); return }
    setAdding(true)
    const r = await fetch('/api/b2b/admin/freight-boxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, sort_order: (boxes.length + 1) * 10 }) })
    setAdding(false)
    if (r.ok) { setNewBox({ name: '', length_mm: '', width_mm: '', height_mm: '', max_weight_kg: '' }); await load(); flashMsg('Box added') }
    else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Add failed') }
  }

  // ── Satchels ──
  async function patchSatchel(id: string, patch: Record<string, any>) {
    const r = await fetch(`/api/b2b/admin/freight-satchels?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) flashMsg('Saved'); else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Save failed') }
  }
  function updateSatLocal(id: string, p: Partial<Satchel>) { setSatchels(ss => ss.map(s => s.id === id ? { ...s, ...p } : s)) }
  async function removeSatchel(id: string, name: string) {
    if (!(await confirmDialog({ title: `Delete satchel "${name}"?`, danger: true }))) return
    const r = await fetch(`/api/b2b/admin/freight-satchels?id=${id}`, { method: 'DELETE' })
    if (r.ok) { setSatchels(ss => ss.filter(s => s.id !== id)); flashMsg('Deleted') }
  }
  async function addSatchel() {
    const payload = { name: newSat.name.trim(), max_weight_g: toG(newSat.max_weight_kg), max_length_mm: toMm(newSat.length_mm), max_width_mm: toMm(newSat.width_mm), max_height_mm: toMm(newSat.height_mm), cost_ex_gst: exFromInc(newSat.cost_inc) ?? 0, sell_ex_gst: exFromInc(newSat.sell_inc) }
    if (!payload.name || !payload.max_weight_g || payload.sell_ex_gst == null) { flashMsg('Fill name, max kg and sell $'); return }
    setAddingSat(true)
    const r = await fetch('/api/b2b/admin/freight-satchels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, sort_order: (satchels.length + 1) * 10 }) })
    setAddingSat(false)
    if (r.ok) { setNewSat({ name: '', length_mm: '', width_mm: '', height_mm: '', max_weight_kg: '', cost_inc: '', sell_inc: '' }); await load(); flashMsg('Satchel added') }
    else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Add failed') }
  }

  async function saveThreshold() {
    setSavingPallet(true)
    const r = await fetch('/api/b2b/admin/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freight_pallet_threshold_g: toG(threshold) }),
    })
    setSavingPallet(false)
    if (r.ok) flashMsg('Threshold saved'); else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Save failed') }
  }

  // ── Pallets ──
  async function patchPallet(id: string, patch: Record<string, any>) {
    const r = await fetch(`/api/b2b/admin/freight-pallets?id=${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (r.ok) flashMsg('Saved'); else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Save failed') }
  }
  function updatePalletLocal(id: string, p: Partial<Pallet>) { setPallets(ps => ps.map(x => x.id === id ? { ...x, ...p } : x)) }
  async function removePallet(id: string, name: string) {
    if (!(await confirmDialog({ title: `Delete pallet "${name}"?`, danger: true }))) return
    const r = await fetch(`/api/b2b/admin/freight-pallets?id=${id}`, { method: 'DELETE' })
    if (r.ok) { setPallets(ps => ps.filter(x => x.id !== id)); flashMsg('Deleted') }
  }
  async function addPallet() {
    const payload = {
      name: newPallet.name.trim(), length_mm: toMm(newPallet.length_mm), width_mm: toMm(newPallet.width_mm),
      max_height_mm: toMm(newPallet.max_height_mm), max_weight_g: toG(newPallet.max_weight_kg),
    }
    if (!payload.name || !payload.length_mm || !payload.width_mm || !payload.max_height_mm || !payload.max_weight_g) { flashMsg('Fill all pallet fields'); return }
    setAddingPallet(true)
    const r = await fetch('/api/b2b/admin/freight-pallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, sort_order: (pallets.length + 1) * 10 }) })
    setAddingPallet(false)
    if (r.ok) { setNewPallet({ name: '', length_mm: '', width_mm: '', max_height_mm: '', max_weight_kg: '' }); await load(); flashMsg('Pallet added') }
    else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Add failed') }
  }


  if (loading) return <SkeletonRows rows={8} />

  const cols = '1.4fr 70px 70px 70px 80px 56px 68px'
  const hdr: React.CSSProperties = { fontSize: 12, color: T.text3, fontWeight: 650 }
  const rowDelete: React.CSSProperties = {
    background: 'none', border: 'none', color: A.bad, cursor: 'pointer',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit', justifySelf: 'center', padding: '2px 4px',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {flash && <div style={{ fontSize: 12.5, color: flash.includes('fail') || flash.includes('Fill') ? A.warn : A.good }}>{flash}</div>}

      {/* Boxes */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>Standard cartons <span style={{ color: T.text3, fontWeight: 400 }}>· usable internal size (cm) + max weight (kg)</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '0 2px 6px' }}>
          <div style={hdr}>Name</div><div style={hdr}>L (cm)</div><div style={hdr}>W (cm)</div><div style={hdr}>H (cm)</div><div style={hdr}>Max kg</div><div style={{ ...hdr, textAlign: 'center' }}>Active</div><div />
        </div>
        {boxes.length === 0 && <div style={{ fontSize: 12.5, color: T.text3, padding: '4px 0 10px' }}>No boxes yet — add your standard cartons below.</div>}
        {boxes.map(b => (
          <div key={b.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '5px 0', alignItems: 'center', borderTop: `1px solid ${T.border}` }}>
            <input style={inp} value={b.name} onChange={e => updateBoxLocal(b.id, { name: e.target.value })} onBlur={e => patchBox(b.id, { name: e.target.value })} />
            <input style={inp} inputMode="decimal" value={cm(b.length_mm)} onChange={e => updateBoxLocal(b.id, { length_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { length_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={cm(b.width_mm)} onChange={e => updateBoxLocal(b.id, { width_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { width_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={cm(b.height_mm)} onChange={e => updateBoxLocal(b.id, { height_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { height_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={kg(b.max_weight_g)} onChange={e => updateBoxLocal(b.id, { max_weight_g: toG(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { max_weight_g: toG(e.target.value) })} />
            <input type="checkbox" checked={b.is_active} onChange={e => { updateBoxLocal(b.id, { is_active: e.target.checked }); patchBox(b.id, { is_active: e.target.checked }) }} style={{ justifySelf: 'center', cursor: 'pointer' }} />
            <button onClick={() => removeBox(b.id, b.name)} title="Delete" className="al-press al-focus" style={rowDelete}>Delete</button>
          </div>
        ))}
        {/* Add row */}
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '8px 0 0', alignItems: 'center', borderTop: `1px solid ${T.border}`, marginTop: 4 }}>
          <input style={inp} placeholder="e.g. Medium" value={newBox.name} onChange={e => setNewBox(s => ({ ...s, name: e.target.value }))} />
          <input style={inp} placeholder="L" inputMode="decimal" value={newBox.length_mm} onChange={e => setNewBox(s => ({ ...s, length_mm: e.target.value }))} />
          <input style={inp} placeholder="W" inputMode="decimal" value={newBox.width_mm} onChange={e => setNewBox(s => ({ ...s, width_mm: e.target.value }))} />
          <input style={inp} placeholder="H" inputMode="decimal" value={newBox.height_mm} onChange={e => setNewBox(s => ({ ...s, height_mm: e.target.value }))} />
          <input style={inp} placeholder="kg" inputMode="decimal" value={newBox.max_weight_kg} onChange={e => setNewBox(s => ({ ...s, max_weight_kg: e.target.value }))} />
          <div style={{ gridColumn: '6 / 8' }}>
            <Btn size="sm" full onClick={addBox} disabled={adding}>{adding ? '…' : 'Add'}</Btn>
          </div>
        </div>
      </div>

      {/* Satchels */}
      {(() => {
        const sCols = '1.5fr 58px 58px 58px 70px 80px 80px 50px 64px'
        return (
          <div>
            <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>Flat-rate satchels <span style={{ color: T.text3, fontWeight: 400 }}>· e.g. Australia Post · flat price anywhere in Aus</span></div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 8, lineHeight: 1.5 }}>Offered alongside carrier rates when an order fits — the cart auto-picks the cheapest. An order qualifies when it's under the max weight <strong>and</strong> all items fit inside the satchel size (combined, ~80% fill). Leave L/W/H blank for a weight-only satchel. Prices are GST-inclusive. Satchel orders ship manually (no auto-booking).</div>
            <div style={{ display: 'grid', gridTemplateColumns: sCols, gap: 6, padding: '0 2px 6px' }}>
              <div style={hdr}>Name</div><div style={hdr}>L cm</div><div style={hdr}>W cm</div><div style={hdr}>H cm</div><div style={hdr}>Max kg</div><div style={hdr}>Cost $ inc</div><div style={hdr}>Sell $ inc</div><div style={{ ...hdr, textAlign: 'center' }}>On</div><div />
            </div>
            {satchels.length === 0 && <div style={{ fontSize: 12.5, color: T.text3, padding: '4px 0 10px' }}>No satchels yet — add your AusPost satchel tiers below (e.g. 500g / 1kg / 3kg / 5kg).</div>}
            {satchels.map(s => (
              <div key={s.id} style={{ display: 'grid', gridTemplateColumns: sCols, gap: 6, padding: '5px 0', alignItems: 'center', borderTop: `1px solid ${T.border}` }}>
                <input style={inp} value={s.name} onChange={e => updateSatLocal(s.id, { name: e.target.value })} onBlur={e => patchSatchel(s.id, { name: e.target.value })} />
                <input style={inp} inputMode="decimal" value={cm(s.max_length_mm)} onChange={e => updateSatLocal(s.id, { max_length_mm: toMm(e.target.value) })} onBlur={e => patchSatchel(s.id, { max_length_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={cm(s.max_width_mm)} onChange={e => updateSatLocal(s.id, { max_width_mm: toMm(e.target.value) })} onBlur={e => patchSatchel(s.id, { max_width_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={cm(s.max_height_mm)} onChange={e => updateSatLocal(s.id, { max_height_mm: toMm(e.target.value) })} onBlur={e => patchSatchel(s.id, { max_height_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={kg(s.max_weight_g)} onChange={e => updateSatLocal(s.id, { max_weight_g: toG(e.target.value) ?? 0 })} onBlur={e => patchSatchel(s.id, { max_weight_g: toG(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={incFromEx(s.cost_ex_gst)} onChange={e => updateSatLocal(s.id, { cost_ex_gst: exFromInc(e.target.value) ?? 0 })} onBlur={e => patchSatchel(s.id, { cost_ex_gst: exFromInc(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={incFromEx(s.sell_ex_gst)} onChange={e => updateSatLocal(s.id, { sell_ex_gst: exFromInc(e.target.value) ?? 0 })} onBlur={e => patchSatchel(s.id, { sell_ex_gst: exFromInc(e.target.value) })} />
                <input type="checkbox" checked={s.is_active} onChange={e => { updateSatLocal(s.id, { is_active: e.target.checked }); patchSatchel(s.id, { is_active: e.target.checked }) }} style={{ justifySelf: 'center', cursor: 'pointer' }} />
                <button onClick={() => removeSatchel(s.id, s.name)} title="Delete" className="al-press al-focus" style={rowDelete}>Delete</button>
              </div>
            ))}
            {/* Add row */}
            <div style={{ display: 'grid', gridTemplateColumns: sCols, gap: 6, padding: '8px 0 0', alignItems: 'center', borderTop: `1px solid ${T.border}`, marginTop: 4 }}>
              <input style={inp} placeholder="e.g. AusPost 5kg" value={newSat.name} onChange={e => setNewSat(s => ({ ...s, name: e.target.value }))} />
              <input style={inp} placeholder="L" inputMode="decimal" value={newSat.length_mm} onChange={e => setNewSat(s => ({ ...s, length_mm: e.target.value }))} />
              <input style={inp} placeholder="W" inputMode="decimal" value={newSat.width_mm} onChange={e => setNewSat(s => ({ ...s, width_mm: e.target.value }))} />
              <input style={inp} placeholder="H" inputMode="decimal" value={newSat.height_mm} onChange={e => setNewSat(s => ({ ...s, height_mm: e.target.value }))} />
              <input style={inp} placeholder="kg" inputMode="decimal" value={newSat.max_weight_kg} onChange={e => setNewSat(s => ({ ...s, max_weight_kg: e.target.value }))} />
              <input style={inp} placeholder="inc" inputMode="decimal" value={newSat.cost_inc} onChange={e => setNewSat(s => ({ ...s, cost_inc: e.target.value }))} />
              <input style={inp} placeholder="inc" inputMode="decimal" value={newSat.sell_inc} onChange={e => setNewSat(s => ({ ...s, sell_inc: e.target.value }))} />
              <div style={{ gridColumn: '8 / 10' }}>
                <Btn size="sm" full onClick={addSatchel} disabled={addingSat}>{addingSat ? '…' : 'Add'}</Btn>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Pallets + threshold */}
      {(() => {
        const pCols = '1.5fr 64px 64px 70px 70px 50px 64px'
        return (
          <div>
            <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>Pallets <span style={{ color: T.text3, fontWeight: 400 }}>· add as many as you ship on</span></div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 8, lineHeight: 1.5 }}>
              When an order palletises, the cartonizer picks the pallet that ships it in the <strong>fewest pallets</strong>, and where two do it in the same number, the <strong>smaller deck</strong> — usually the cheaper freight. Max stack H is the tallest we will build on that pallet.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: pCols, gap: 6, padding: '0 2px 6px' }}>
              <div style={hdr}>Name</div><div style={hdr}>L cm</div><div style={hdr}>W cm</div><div style={hdr}>Max H cm</div><div style={hdr}>Max kg</div><div style={{ ...hdr, textAlign: 'center' }}>On</div><div />
            </div>
            {pallets.length === 0 && <div style={{ fontSize: 12.5, color: T.text3, padding: '4px 0 10px' }}>No pallets configured — orders will ship in cartons regardless of weight until you add one.</div>}
            {pallets.map(pl => (
              <div key={pl.id} style={{ display: 'grid', gridTemplateColumns: pCols, gap: 6, padding: '5px 0', alignItems: 'center', borderTop: `1px solid ${T.border}` }}>
                <input style={inp} value={pl.name} onChange={e => updatePalletLocal(pl.id, { name: e.target.value })} onBlur={e => patchPallet(pl.id, { name: e.target.value })} />
                <input style={inp} inputMode="decimal" value={cm(pl.length_mm)} onChange={e => updatePalletLocal(pl.id, { length_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchPallet(pl.id, { length_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={cm(pl.width_mm)} onChange={e => updatePalletLocal(pl.id, { width_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchPallet(pl.id, { width_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={cm(pl.max_height_mm)} onChange={e => updatePalletLocal(pl.id, { max_height_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchPallet(pl.id, { max_height_mm: toMm(e.target.value) })} />
                <input style={inp} inputMode="decimal" value={kg(pl.max_weight_g)} onChange={e => updatePalletLocal(pl.id, { max_weight_g: toG(e.target.value) ?? 0 })} onBlur={e => patchPallet(pl.id, { max_weight_g: toG(e.target.value) })} />
                <input type="checkbox" checked={pl.is_active} onChange={e => { updatePalletLocal(pl.id, { is_active: e.target.checked }); patchPallet(pl.id, { is_active: e.target.checked }) }} style={{ justifySelf: 'center', cursor: 'pointer' }} />
                <button onClick={() => removePallet(pl.id, pl.name)} title="Delete" className="al-press al-focus" style={rowDelete}>Delete</button>
              </div>
            ))}
            {/* Add row */}
            <div style={{ display: 'grid', gridTemplateColumns: pCols, gap: 6, padding: '8px 0 0', alignItems: 'center', borderTop: `1px solid ${T.border}`, marginTop: 4 }}>
              <input style={inp} placeholder="e.g. Half pallet" value={newPallet.name} onChange={e => setNewPallet(x => ({ ...x, name: e.target.value }))} />
              <input style={inp} placeholder="L" inputMode="decimal" value={newPallet.length_mm} onChange={e => setNewPallet(x => ({ ...x, length_mm: e.target.value }))} />
              <input style={inp} placeholder="W" inputMode="decimal" value={newPallet.width_mm} onChange={e => setNewPallet(x => ({ ...x, width_mm: e.target.value }))} />
              <input style={inp} placeholder="H" inputMode="decimal" value={newPallet.max_height_mm} onChange={e => setNewPallet(x => ({ ...x, max_height_mm: e.target.value }))} />
              <input style={inp} placeholder="kg" inputMode="decimal" value={newPallet.max_weight_kg} onChange={e => setNewPallet(x => ({ ...x, max_weight_kg: e.target.value }))} />
              <div style={{ gridColumn: '6 / 8' }}>
                <Btn size="sm" full onClick={addPallet} disabled={addingPallet}>{addingPallet ? '…' : 'Add'}</Btn>
              </div>
            </div>

            {/* Threshold — an order-level setting, not a property of any pallet */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 180 }}>
                <span style={hdr}>Palletise over (kg)</span>
                <input style={inp} inputMode="decimal" value={threshold} onChange={e => setThreshold(e.target.value)} />
              </label>
              <Btn size="sm" onClick={saveThreshold} disabled={savingPallet}>{savingPallet ? 'Saving…' : 'Save threshold'}</Btn>
              <div style={{ fontSize: 12, color: T.text3, lineHeight: 1.5, flex: 1 }}>An order heavier than this ships on pallets instead of boxes. Applies to the order as a whole, so it is set once rather than per pallet.</div>
            </div>
          </div>
        )
      })()}

      <div style={{ fontSize: 12, color: T.text3, lineHeight: 1.6, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
        These feed the freight cartonizer (coming next): it packs an order's items into the fewest cartons that fit by volume + weight, or onto a pallet once total weight passes the threshold — then quotes/books that. Box edits save as you leave each field.
      </div>
    </div>
  )
}

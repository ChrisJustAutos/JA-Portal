// components/b2b/FreightPackagingManager.tsx
// Edit the standard freight cartons + pallet spec + palletise-by-weight
// threshold. Feeds the cartonizer that packs multi-item orders for MachShip.
// Dims are entered in mm; weights in kg (stored as grams).

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'
import { useConfirm } from '../ui/Feedback'

const inp: React.CSSProperties = { padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 5, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%' }
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
interface Satchel { id: string; name: string; max_weight_g: number; max_length_mm: number | null; max_width_mm: number | null; max_height_mm: number | null; cost_ex_gst: number; sell_ex_gst: number; sort_order: number; is_active: boolean }

export default function FreightPackagingManager() {
  const confirmDialog = useConfirm()
  const [boxes, setBoxes] = useState<Box[]>([])
  const [satchels, setSatchels] = useState<Satchel[]>([])
  const [pallet, setPallet] = useState({ length_mm: '', width_mm: '', max_height_mm: '', max_weight_kg: '', threshold_kg: '' })
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
    const [bx, sat, st] = await Promise.all([
      fetch('/api/b2b/admin/freight-boxes').then(r => r.ok ? r.json() : { boxes: [] }),
      fetch('/api/b2b/admin/freight-satchels').then(r => r.ok ? r.json() : { satchels: [] }),
      fetch('/api/b2b/admin/settings').then(r => r.ok ? r.json() : null),
    ])
    setBoxes(bx.boxes || [])
    setSatchels(sat.satchels || [])
    const s = st?.settings || {}
    setPallet({
      length_mm: cm(s.freight_pallet_length_mm), width_mm: cm(s.freight_pallet_width_mm),
      max_height_mm: cm(s.freight_pallet_max_height_mm), max_weight_kg: kg(s.freight_pallet_max_weight_g),
      threshold_kg: kg(s.freight_pallet_threshold_g),
    })
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

  async function savePallet() {
    setSavingPallet(true)
    const body = {
      freight_pallet_length_mm: toMm(pallet.length_mm), freight_pallet_width_mm: toMm(pallet.width_mm),
      freight_pallet_max_height_mm: toMm(pallet.max_height_mm), freight_pallet_max_weight_g: toG(pallet.max_weight_kg),
      freight_pallet_threshold_g: toG(pallet.threshold_kg),
    }
    const r = await fetch('/api/b2b/admin/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setSavingPallet(false)
    if (r.ok) flashMsg('Pallet settings saved'); else { const d = await r.json().catch(() => ({})); flashMsg(d.issues?.join('; ') || d.error || 'Save failed') }
  }

  if (loading) return <SkeletonRows rows={8} />

  const cols = '1.4fr 70px 70px 70px 80px 56px 30px'
  const hdr: React.CSSProperties = { fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {flash && <div style={{ fontSize: 12, color: flash.includes('fail') || flash.includes('Fill') ? T.amber : T.green }}>{flash}</div>}

      {/* Boxes */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Standard cartons <span style={{ color: T.text3, fontWeight: 400 }}>· usable internal size (cm) + max weight (kg)</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '0 2px 6px' }}>
          <div style={hdr}>Name</div><div style={hdr}>L (cm)</div><div style={hdr}>W (cm)</div><div style={hdr}>H (cm)</div><div style={hdr}>Max kg</div><div style={{ ...hdr, textAlign: 'center' }}>Active</div><div />
        </div>
        {boxes.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '4px 0 10px' }}>No boxes yet — add your standard cartons below.</div>}
        {boxes.map(b => (
          <div key={b.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '5px 0', alignItems: 'center', borderTop: `1px solid ${T.border}` }}>
            <input style={inp} value={b.name} onChange={e => updateBoxLocal(b.id, { name: e.target.value })} onBlur={e => patchBox(b.id, { name: e.target.value })} />
            <input style={inp} inputMode="decimal" value={cm(b.length_mm)} onChange={e => updateBoxLocal(b.id, { length_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { length_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={cm(b.width_mm)} onChange={e => updateBoxLocal(b.id, { width_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { width_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={cm(b.height_mm)} onChange={e => updateBoxLocal(b.id, { height_mm: toMm(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { height_mm: toMm(e.target.value) })} />
            <input style={inp} inputMode="decimal" value={kg(b.max_weight_g)} onChange={e => updateBoxLocal(b.id, { max_weight_g: toG(e.target.value) ?? 0 })} onBlur={e => patchBox(b.id, { max_weight_g: toG(e.target.value) })} />
            <input type="checkbox" checked={b.is_active} onChange={e => { updateBoxLocal(b.id, { is_active: e.target.checked }); patchBox(b.id, { is_active: e.target.checked }) }} style={{ justifySelf: 'center', cursor: 'pointer' }} />
            <button onClick={() => removeBox(b.id, b.name)} title="Delete" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 15, justifySelf: 'center' }}>×</button>
          </div>
        ))}
        {/* Add row */}
        <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, padding: '8px 0 0', alignItems: 'center', borderTop: `1px solid ${T.border}`, marginTop: 4 }}>
          <input style={inp} placeholder="e.g. Medium" value={newBox.name} onChange={e => setNewBox(s => ({ ...s, name: e.target.value }))} />
          <input style={inp} placeholder="L" inputMode="decimal" value={newBox.length_mm} onChange={e => setNewBox(s => ({ ...s, length_mm: e.target.value }))} />
          <input style={inp} placeholder="W" inputMode="decimal" value={newBox.width_mm} onChange={e => setNewBox(s => ({ ...s, width_mm: e.target.value }))} />
          <input style={inp} placeholder="H" inputMode="decimal" value={newBox.height_mm} onChange={e => setNewBox(s => ({ ...s, height_mm: e.target.value }))} />
          <input style={inp} placeholder="kg" inputMode="decimal" value={newBox.max_weight_kg} onChange={e => setNewBox(s => ({ ...s, max_weight_kg: e.target.value }))} />
          <button onClick={addBox} disabled={adding} style={{ gridColumn: '6 / 8', padding: '6px 10px', borderRadius: 5, border: 'none', background: T.blue, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{adding ? '…' : '+ Add'}</button>
        </div>
      </div>

      {/* Satchels */}
      {(() => {
        const sCols = '1.5fr 58px 58px 58px 70px 80px 80px 50px 26px'
        return (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Flat-rate satchels <span style={{ color: T.text3, fontWeight: 400 }}>· e.g. Australia Post · flat price anywhere in Aus</span></div>
            <div style={{ fontSize: 11, color: T.text3, marginBottom: 8 }}>Offered alongside carrier rates when an order fits — the cart auto-picks the cheapest. An order qualifies when it's under the max weight <strong>and</strong> all items fit inside the satchel size (combined, ~80% fill). Leave L/W/H blank for a weight-only satchel. Prices are GST-inclusive. Satchel orders ship manually (no auto-booking).</div>
            <div style={{ display: 'grid', gridTemplateColumns: sCols, gap: 6, padding: '0 2px 6px' }}>
              <div style={hdr}>Name</div><div style={hdr}>L cm</div><div style={hdr}>W cm</div><div style={hdr}>H cm</div><div style={hdr}>Max kg</div><div style={hdr}>Cost $ inc</div><div style={hdr}>Sell $ inc</div><div style={{ ...hdr, textAlign: 'center' }}>On</div><div />
            </div>
            {satchels.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '4px 0 10px' }}>No satchels yet — add your AusPost satchel tiers below (e.g. 500g / 1kg / 3kg / 5kg).</div>}
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
                <button onClick={() => removeSatchel(s.id, s.name)} title="Delete" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 15, justifySelf: 'center' }}>×</button>
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
              <button onClick={addSatchel} disabled={addingSat} style={{ gridColumn: '8 / 10', padding: '6px 8px', borderRadius: 5, border: 'none', background: T.blue, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{addingSat ? '…' : '+ Add'}</button>
            </div>
          </div>
        )
      })()}

      {/* Pallet + threshold */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Pallet &amp; threshold</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
          {([['length_mm', 'Pallet L (cm)'], ['width_mm', 'Pallet W (cm)'], ['max_height_mm', 'Max stack H (cm)'], ['max_weight_kg', 'Max kg'], ['threshold_kg', 'Palletise over (kg)']] as const).map(([k, label]) => (
            <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ ...hdr }}>{label}</span>
              <input style={inp} inputMode="decimal" value={(pallet as any)[k]} onChange={e => setPallet(p => ({ ...p, [k]: e.target.value }))} />
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11, color: T.text3, margin: '8px 0' }}>An order whose total weight exceeds <strong>Palletise over</strong> ships on a pallet instead of boxes.</div>
        <button onClick={savePallet} disabled={savingPallet} style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: T.blue, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{savingPallet ? 'Saving…' : 'Save pallet settings'}</button>
      </div>

      <div style={{ fontSize: 11, color: T.text3, lineHeight: 1.6, borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
        These feed the freight cartonizer (coming next): it packs an order's items into the fewest cartons that fit by volume + weight, or onto a pallet once total weight passes the threshold — then quotes/books that. Box edits save as you leave each field.
      </div>
    </div>
  )
}

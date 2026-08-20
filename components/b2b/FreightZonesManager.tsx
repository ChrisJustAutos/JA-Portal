// components/b2b/FreightZonesManager.tsx
// Admin UI for B2B freight zones + their rates. Mounted on
// /admin/b2b/settings under a "Freight" section. Each zone holds 1+
// rates (e.g. Standard, Express). Postcode ranges are entered as a
// comma-separated string ("4000-4179, 4500-4999, 4600") and parsed by
// the API on save.
//
// Self-contained: fetches its own data from /api/b2b/admin/freight-zones
// and /api/b2b/admin/freight-rates. Failures surface inline.
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useCallback, useEffect, useState } from 'react'
import { useConfirm } from '../ui/Feedback'
import { SkeletonRows } from '../ui'
import { T } from '../../lib/ui/theme'
import { A, Btn, Banner, inputStyle, RADIUS } from './ui'

interface FreightRate {
  id: string
  zone_id: string
  label: string
  price_ex_gst: number
  transit_days: number | null
  sort_order: number
  is_active: boolean
}

interface FreightZone {
  id: string
  name: string
  postcode_ranges: { start: string; end: string }[]
  sort_order: number
  is_active: boolean
  rates: FreightRate[]
}

function rangesToText(ranges: { start: string; end: string }[]): string {
  if (!Array.isArray(ranges)) return ''
  return ranges.map(r => r.start === r.end ? r.start : `${r.start}-${r.end}`).join(', ')
}

export default function FreightZonesManager() {
  const confirmDialog = useConfirm()
  const [zones, setZones] = useState<FreightZone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/b2b/admin/freight-zones')
      if (!r.ok) throw new Error((await r.json()).error || 'Load failed')
      const j = await r.json()
      setZones(j.zones || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function patchZone(id: string, body: Record<string, any>) {
    setBusy(id); setError('')
    try {
      const r = await fetch(`/api/b2b/admin/freight-zones?id=${id}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function deleteZone(z: FreightZone) {
    if (!(await confirmDialog({ title: `Delete freight zone "${z.name}" and its ${z.rates.length} rate${z.rates.length === 1 ? '' : 's'}?`, danger: true }))) return
    setBusy(z.id); setError('')
    try {
      const r = await fetch(`/api/b2b/admin/freight-zones?id=${z.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }

  return (
    <div>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:6}}>
        <div style={{fontSize:14, fontWeight:650, color:T.text, flex:1}}>Freight zones</div>
        <Btn variant={addOpen ? 'ghost' : 'secondary'} size="sm" onClick={() => setAddOpen(o => !o)}>
          {addOpen ? 'Cancel' : 'Add zone'}
        </Btn>
      </div>
      <div style={{fontSize:12.5, color:T.text3, marginBottom:14, lineHeight:1.5}}>
        Distributors at checkout see the rates from the first matching zone (by sort order). Postcode ranges:
        e.g. <code style={{color:T.text2, fontSize:12}}>4000-4179, 4500-4999, 4600</code>.
      </div>

      {error && (
        <div style={{marginBottom:10}}>
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {addOpen && (
        <AddZoneForm onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void load() }} />
      )}

      {loading && <SkeletonRows rows={8}/>}

      {!loading && zones.length === 0 && !addOpen && (
        <div style={{fontSize:12.5, color:T.text3, padding:'10px 0'}}>
          No zones configured yet. Distributors will see "no freight available" at checkout until you add at least one.
        </div>
      )}

      {!loading && zones.map(z => (
        <ZoneRow
          key={z.id}
          zone={z}
          busy={busy === z.id}
          onPatch={p => patchZone(z.id, p)}
          onDelete={() => deleteZone(z)}
          onChange={() => void load()}
        />
      ))}
    </div>
  )
}

// ── Single zone row + its rates ─────────────────────────────────────────

function ZoneRow({ zone, busy, onPatch, onDelete, onChange }: {
  zone: FreightZone
  busy: boolean
  onPatch: (body: Record<string, any>) => void | Promise<void>
  onDelete: () => void | Promise<void>
  onChange: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(zone.name)
  const [rangesText, setRangesText] = useState(rangesToText(zone.postcode_ranges))
  const [sortOrder, setSortOrder] = useState(zone.sort_order)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    setSaving(true); setErr('')
    try {
      await onPatch({ name: name.trim(), postcode_ranges: rangesText, sort_order: Number(sortOrder) || 0 })
      setEditing(false)
    } catch (e: any) { setErr(e?.message || 'save failed') }
    finally { setSaving(false) }
  }

  return (
    <div style={{
      marginBottom:10, padding:'12px 14px',
      background: T.bg3,
      opacity: zone.is_active ? 1 : 0.6,
      borderRadius:RADIUS.sm + 2,
    }}>
      <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
        {editing ? (
          <>
            <input value={name} onChange={e => setName(e.target.value)} style={inp(180)} placeholder="Zone name"/>
            <input value={rangesText} onChange={e => setRangesText(e.target.value)} style={inp(280)} placeholder="4000-4179, 4500-4999"/>
            <input type="number" value={sortOrder} onChange={e => setSortOrder(Number(e.target.value))} style={inp(70)} title="Sort order"/>
            <Btn size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
            <Btn variant="ghost" size="sm" onClick={() => { setEditing(false); setName(zone.name); setRangesText(rangesToText(zone.postcode_ranges)); setSortOrder(zone.sort_order) }} disabled={saving}>Cancel</Btn>
          </>
        ) : (
          <>
            <strong style={{fontSize:13, color:T.text, minWidth:140}}>{zone.name}</strong>
            <span style={{fontSize:12, fontFamily:'monospace', color:T.text3, flex:1}}>
              {rangesToText(zone.postcode_ranges) || '(no postcodes)'}
            </span>
            <span style={{fontSize:12, color:T.text3}}>#{zone.sort_order}</span>
            <label style={{fontSize:12, color:T.text2, display:'flex', alignItems:'center', gap:4, cursor:'pointer'}}>
              <input type="checkbox" checked={zone.is_active} disabled={busy}
                onChange={e => onPatch({ is_active: e.target.checked })}/>
              Active
            </label>
            <Btn variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={busy}>Edit</Btn>
            <button onClick={onDelete} disabled={busy} className="al-press al-focus al-ghost" style={dangerBtn}>Delete</button>
          </>
        )}
      </div>
      {err && <div style={{marginTop:6, fontSize:12, color:A.bad}}>{err}</div>}

      <RatesEditor zoneId={zone.id} rates={zone.rates} onChange={onChange}/>
    </div>
  )
}

// ── Rates within a zone ────────────────────────────────────────────────

function RatesEditor({ zoneId, rates, onChange }: { zoneId: string; rates: FreightRate[]; onChange: () => void }) {
  const confirmDialog = useConfirm()
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newDays, setNewDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function addRate() {
    if (!newLabel.trim() || !newPrice) { setErr('Label + price required'); return }
    setBusy(true); setErr('')
    try {
      const r = await fetch('/api/b2b/admin/freight-rates', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          zone_id: zoneId,
          label: newLabel.trim(),
          price_ex_gst: Number(newPrice),
          transit_days: newDays ? Number(newDays) : null,
          sort_order: rates.length,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Add failed')
      setNewLabel(''); setNewPrice(''); setNewDays(''); setAdding(false)
      onChange()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  async function patchRate(id: string, body: Record<string, any>) {
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/b2b/admin/freight-rates?id=${id}`, {
        method: 'PATCH', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed')
      onChange()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  async function deleteRate(rate: FreightRate) {
    if (!(await confirmDialog({ title: `Delete rate "${rate.label}"?`, danger: true }))) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/b2b/admin/freight-rates?id=${rate.id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed')
      onChange()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={{marginTop:10, paddingLeft:8, borderLeft:`2px solid ${T.border}`}}>
      <div style={{fontSize:12, color:T.text2, fontWeight:650, marginBottom:6}}>Rates</div>

      {rates.length === 0 && (
        <div style={{fontSize:12, color:T.text3, padding:'4px 0', fontStyle:'italic'}}>No rates yet — add at least one.</div>
      )}

      {rates.map(r => (
        <div key={r.id} style={{display:'flex', alignItems:'center', gap:8, padding:'4px 0', fontSize:12.5}}>
          <span style={{color:T.text, minWidth:120}}>{r.label}</span>
          <span style={{fontFamily:'monospace', fontSize:12, color:T.text2, minWidth:80}}>${r.price_ex_gst.toFixed(2)} ex</span>
          <span style={{color:T.text3, minWidth:90}}>
            {r.transit_days != null ? `${r.transit_days}d transit` : '—'}
          </span>
          <label style={{fontSize:12, color:T.text2, display:'flex', alignItems:'center', gap:4, cursor:'pointer'}}>
            <input type="checkbox" checked={r.is_active} disabled={busy}
              onChange={e => patchRate(r.id, { is_active: e.target.checked })}/>
            Active
          </label>
          <span style={{flex:1}}/>
          <button onClick={() => deleteRate(r)} disabled={busy} className="al-press al-focus al-ghost" style={dangerBtn}>Delete</button>
        </div>
      ))}

      {adding ? (
        <div style={{display:'flex', alignItems:'center', gap:8, padding:'6px 0', flexWrap:'wrap'}}>
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. Standard" style={inp(140)} autoFocus/>
          <input value={newPrice} onChange={e => setNewPrice(e.target.value)} placeholder="Price ex GST" type="number" step="0.01" style={inp(110)}/>
          <input value={newDays} onChange={e => setNewDays(e.target.value)} placeholder="Days" type="number" style={inp(70)}/>
          <Btn size="sm" onClick={addRate} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => { setAdding(false); setNewLabel(''); setNewPrice(''); setNewDays('') }} disabled={busy}>Cancel</Btn>
        </div>
      ) : (
        <div style={{marginTop:4}}>
          <Btn variant="ghost" size="sm" onClick={() => setAdding(true)}>+ Add rate</Btn>
        </div>
      )}

      {err && <div style={{fontSize:12, color:A.bad, marginTop:4}}>{err}</div>}
    </div>
  )
}

// ── Add new zone form ──────────────────────────────────────────────────

function AddZoneForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [rangesText, setRangesText] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function save() {
    if (!name.trim() || !rangesText.trim()) { setErr('Name + ranges required'); return }
    setSaving(true); setErr('')
    try {
      const r = await fetch('/api/b2b/admin/freight-zones', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: name.trim(), postcode_ranges: rangesText, sort_order: 0, is_active: true }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Create failed')
      onSaved()
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{marginBottom:10, padding:12, background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:RADIUS.sm}}>
      <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Zone name (e.g. QLD Metro)" style={inp(200)}/>
        <input value={rangesText} onChange={e => setRangesText(e.target.value)} placeholder="4000-4179, 4500-4999" style={inp(300)}/>
        <Btn size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add zone'}</Btn>
        <Btn variant="ghost" size="sm" onClick={onClose} disabled={saving}>Cancel</Btn>
      </div>
      {err && <div style={{marginTop:6, fontSize:12, color:A.bad}}>{err}</div>}
      <div style={{marginTop:6, fontSize:12, color:T.text3}}>
        After saving, click into the zone to add rates (Standard, Express, etc.).
      </div>
    </div>
  )
}

// ── Style helpers ──────────────────────────────────────────────────────
// Dense row inputs — kit look scaled for inline editing (floor is 12px type).

function inp(width: number): React.CSSProperties {
  return {
    ...inputStyle(),
    width, background:T.bg4,
    padding:'7px 10px', fontSize:13, minHeight:34,
  }
}

const dangerBtn: React.CSSProperties = {
  padding:'4px 12px', borderRadius:RADIUS.pill, minHeight:28,
  border:'1px solid transparent', background:'transparent',
  color:A.bad, fontSize:12, fontWeight:600, fontFamily:'inherit', cursor:'pointer', whiteSpace:'nowrap',
}

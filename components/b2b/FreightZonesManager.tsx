// components/b2b/FreightZonesManager.tsx
// Admin UI for the B2B freight ZONES. Mounted on
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
    // Deleting a zone removes a COLUMN from every drop-ship product's freight
    // grid, which is a bigger deal than losing a rate row and should say so.
    if (!(await confirmDialog({ title: `Delete freight zone "${z.name}"?`, message: 'Any drop-ship product priced for this zone loses that price, and orders shipping to these postcodes will have no drop-ship freight.', danger: true }))) return
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
        These zones are the COLUMNS of each drop-ship product&apos;s freight grid — set the actual prices on the
        product itself, under Catalogue → the item → Drop-ship freight. Nothing is priced here.
        Warehouse freight is live carrier rates only and ignores these zones entirely.
        Postcode ranges: e.g. <code style={{color:T.text2, fontSize:12}}>4000-4179, 4500-4999, 4600</code>.
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

    </div>
  )
}

// ── Rates within a zone ────────────────────────────────────────────────


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

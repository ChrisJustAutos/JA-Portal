// components/admin/ExclusionsTab.tsx
// Admin UI for managing distributor_report_excluded_customers.
// Shown as a tab on the Distributor Groups admin page.
//
// Note values are constrained to: 'Excluded' | 'Sundry' | 'Internal'.
// - Excluded: hidden from the distributor report (staff, unwanted)
// - Sundry:   surfaced as a 'Sundry' group on the report (retail/trade-in)
// - Internal: hidden (VPS intercompany transfers)
//
// SAFE-SAVE BEHAVIOUR (29 Apr 2026 fix):
//   The server now diffs the incoming list against the DB and applies
//   inserts/updates/deletes individually. The save flow here surfaces:
//     - explicit confirmation if you're about to save an empty list
//     - the diff summary on success (X added, Y updated, Z removed)
//     - clear error messages if any rows fail
//     - automatic notice that the distributor report cache was cleared

import { useEffect, useState, useCallback } from 'react'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

type Note = 'Excluded' | 'Sundry' | 'Internal'
interface ExcludedRow { id?: string; customer_name: string; note: Note }

const NOTE_OPTIONS: { value: Note; label: string; color: string; desc: string }[] = [
  { value: 'Excluded', label: 'Excluded', color: T.red,    desc: 'Hidden from the distributor report (staff, unwanted customers)' },
  { value: 'Sundry',   label: 'Sundry',   color: T.amber,  desc: 'Surfaced as a dedicated Sundry group on the report (retail / trade-in)' },
  { value: 'Internal', label: 'Internal', color: T.purple, desc: 'Hidden — VPS intercompany, related entities' },
]
const NOTE_COLOR: Record<Note, string> = { Excluded: T.red, Sundry: T.amber, Internal: T.purple }

interface Props {
  myobCustomers: string[]   // from /api/groups/myob-customers
}

interface SaveResult {
  inserted: number
  updated: number
  deleted: number
  unchanged: number
  cacheCleared: number
  errors?: string[]
  partial?: boolean
}

export default function ExclusionsTab({ myobCustomers }: Props) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState<SaveResult | null>(null)
  const [rows, setRows] = useState<ExcludedRow[]>([])
  const [originalRows, setOriginalRows] = useState<ExcludedRow[]>([])
  const [dirty, setDirty] = useState(false)
  const [filterNote, setFilterNote] = useState<Note | 'All'>('All')

  const [newName, setNewName] = useState('')
  const [newNote, setNewNote] = useState<Note>('Excluded')

  const load = useCallback(async () => {
    setLoading(true); setError(''); setSuccess(null)
    try {
      const r = await fetch('/api/exclusions')
      if (!r.ok) throw new Error((await r.json()).error || 'Load failed')
      const d = await r.json()
      const sorted = (d.excluded || []).sort((a: ExcludedRow, b: ExcludedRow) =>
        a.customer_name.localeCompare(b.customer_name)
      )
      setRows(sorted)
      setOriginalRows(JSON.parse(JSON.stringify(sorted)))   // deep clone for diff display
      setDirty(false)
    } catch (e: any) {
      setError(e.message || 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  function markDirty() { setDirty(true); setError(''); setSuccess(null) }

  function addRow() {
    const name = newName.trim()
    if (!name) return
    if (rows.some(r => r.customer_name.toLowerCase() === name.toLowerCase())) {
      setError(`"${name}" is already in the list`)
      return
    }
    setRows([...rows, { customer_name: name, note: newNote }]
      .sort((a, b) => a.customer_name.localeCompare(b.customer_name)))
    setNewName(''); setNewNote('Excluded')
    markDirty()
  }

  function removeRow(idx: number) {
    setRows(rows.filter((_, i) => i !== idx))
    markDirty()
  }

  function changeRowNote(idx: number, note: Note) {
    const next = [...rows]
    next[idx] = { ...next[idx], note }
    setRows(next)
    markDirty()
  }

  // ── Save flow ─────────────────────────────────────────────────────
  // Empty-list confirmation: if the user has somehow ended up with zero rows
  // (unintentional clear, accidental delete-all), demand explicit confirmation
  // before sending. Server enforces the same guard.
  async function save() {
    if (rows.length === 0 && originalRows.length > 0) {
      const ok = confirm(
        `⚠️ You are about to save an EMPTY exclusion list.\n\n` +
        `This will REMOVE all ${originalRows.length} existing exclusions, which means every customer ` +
        `will appear on the distributor report (including staff, internal entities, and sundries).\n\n` +
        `Are you SURE this is what you want?`
      )
      if (!ok) return
    }

    setSaving(true); setError(''); setSuccess(null)
    try {
      const url = rows.length === 0
        ? '/api/exclusions?confirmEmpty=1'
        : '/api/exclusions'

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ excluded: rows }),
      })
      const d = await r.json()

      if (!r.ok && r.status !== 207) {
        throw new Error(d.error || `Save failed (HTTP ${r.status})`)
      }

      setSuccess({
        inserted: d.inserted || 0,
        updated: d.updated || 0,
        deleted: d.deleted || 0,
        unchanged: d.unchanged || 0,
        cacheCleared: d.cacheCleared || 0,
        errors: d.errors,
        partial: d.partial,
      })

      // Reload to pick up the freshly-persisted IDs and confirm state
      await load()
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Customer suggestions — MYOB names not already in the excluded list
  const existingLower = new Set(rows.map(r => r.customer_name.toLowerCase()))
  const suggestions = (myobCustomers || []).filter(c =>
    !existingLower.has(c.toLowerCase())
    && (newName.trim() === '' || c.toLowerCase().includes(newName.trim().toLowerCase()))
  ).slice(0, 8)

  const visibleRows = filterNote === 'All' ? rows : rows.filter(r => r.note === filterNote)
  const countByNote = {
    Excluded: rows.filter(r => r.note === 'Excluded').length,
    Sundry:   rows.filter(r => r.note === 'Sundry').length,
    Internal: rows.filter(r => r.note === 'Internal').length,
  }

  return (
    <div style={{display:'flex', flexDirection:'column', gap:16}}>
      {/* Header / explainer */}
      <div style={{display:'flex', alignItems:'flex-start', gap:14, padding:16, background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10}}>
        <div style={{fontSize:20, lineHeight:1}}>⛔</div>
        <div style={{fontSize:12, color:T.text2, lineHeight:1.6}}>
          Customers on this list are removed from the main distributor tables. Pick a category:
          <div style={{display:'flex', gap:10, marginTop:8, flexWrap:'wrap'}}>
            {NOTE_OPTIONS.map(o => (
              <div key={o.value} style={{display:'flex', alignItems:'center', gap:6, fontSize:11, color:T.text3}}>
                <span style={{width:8, height:8, borderRadius:2, background:o.color, display:'inline-block'}}/>
                <strong style={{color:T.text2}}>{o.label}</strong> — {o.desc}
              </div>
            ))}
          </div>
          <div style={{marginTop:8, color:T.text3}}>Matching is case-insensitive and checks both the raw MYOB customer name AND the name with "(Tuning)" / "(Tuning 1)" / "(Tuning 2)" suffixes stripped.</div>
        </div>
      </div>

      {/* Add form */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:16}}>
        <div style={{fontSize:12, fontWeight:600, color:T.text2, marginBottom:10, textTransform:'uppercase', letterSpacing:'0.05em'}}>
          Add a customer
        </div>
        <div style={{display:'flex', gap:8, alignItems:'flex-start', flexWrap:'wrap'}}>
          <div style={{flex:1, minWidth:240, position:'relative'}}>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRow() } }}
              list="myob-cust-suggestions"
              placeholder="Customer name (type to search MYOB customers)"
              style={{width:'100%', background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'8px 12px', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box'}}/>
            <datalist id="myob-cust-suggestions">
              {suggestions.map(s => <option key={s} value={s}/>)}
            </datalist>
          </div>
          <select value={newNote} onChange={e => setNewNote(e.target.value as Note)}
            style={{background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'8px 12px', fontSize:13, fontFamily:'inherit', outline:'none', minWidth:140}}>
            {NOTE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button onClick={addRow} disabled={!newName.trim()}
            style={{padding:'8px 18px', borderRadius:6, border:'none', background: newName.trim() ? T.accent : T.bg3, color: newName.trim() ? '#fff' : T.text3, fontSize:12, fontFamily:'inherit', cursor: newName.trim() ? 'pointer' : 'not-allowed', fontWeight:600}}>
            Add
          </button>
        </div>
      </div>

      {/* Status banners */}
      {error && (
        <div style={{background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:7, padding:'10px 12px', color:T.red, fontSize:12, lineHeight:1.5}}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {success && (
        <div style={{background: success.partial ? `${T.amber}15` : `${T.green}15`,
                     border: `1px solid ${success.partial ? T.amber+'40' : T.green+'40'}`,
                     borderRadius:7, padding:'10px 12px',
                     color: success.partial ? T.amber : T.green, fontSize:12, lineHeight:1.6}}>
          <strong>{success.partial ? 'Partial save — review errors below' : 'Saved'}:</strong>{' '}
          {success.inserted} added, {success.updated} updated, {success.deleted} removed
          {success.unchanged > 0 && `, ${success.unchanged} unchanged`}
          {success.cacheCleared > 0 && ` · cleared ${success.cacheCleared} cached report ranges (next page load will recompute live)`}
          {success.errors && success.errors.length > 0 && (
            <ul style={{marginTop:6, marginBottom:0, paddingLeft:18}}>
              {success.errors.map((e, i) => <li key={i} style={{color:T.red, fontSize:11}}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* List */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, overflow:'hidden'}}>
        <div style={{padding:'12px 16px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap'}}>
          <div style={{fontSize:13, fontWeight:600, color:T.text}}>{rows.length} customer{rows.length===1?'':'s'}</div>
          <div style={{display:'flex', gap:4}}>
            {(['All','Excluded','Sundry','Internal'] as const).map(n => {
              const isActive = filterNote === n
              const count = n === 'All' ? rows.length : countByNote[n]
              return (
                <button key={n} onClick={() => setFilterNote(n)}
                  style={{padding:'4px 10px', borderRadius:4,
                    border:`1px solid ${isActive ? T.accent : T.border2}`,
                    background: isActive ? `${T.accent}22` : 'transparent',
                    color: isActive ? T.accent : T.text2,
                    fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
                  {n} ({count})
                </button>
              )
            })}
          </div>
        </div>

        {loading && <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12}}>Loading…</div>}
        {!loading && visibleRows.length === 0 && (
          <div style={{padding:30, textAlign:'center', color:T.text3, fontSize:12, fontStyle:'italic'}}>
            {rows.length === 0 ? 'No customers on the list yet.' : 'No customers match the current filter.'}
          </div>
        )}
        {!loading && visibleRows.map((x) => {
          const realIdx = rows.findIndex(r => r.customer_name === x.customer_name)
          return (
            <div key={x.customer_name} style={{display:'flex', alignItems:'center', gap:12, padding:'8px 16px', borderTop:`1px solid ${T.border}`}}>
              <span style={{fontSize:13, color:T.text, flex:1}}>{x.customer_name}</span>
              <select value={x.note} onChange={e => changeRowNote(realIdx, e.target.value as Note)}
                style={{background:T.bg3, border:`1px solid ${NOTE_COLOR[x.note]}40`, color:NOTE_COLOR[x.note], borderRadius:4, padding:'3px 8px', fontSize:11, fontFamily:'inherit', cursor:'pointer', fontWeight:600, outline:'none'}}>
                {NOTE_OPTIONS.map(o => <option key={o.value} value={o.value} style={{color:T.text, background:T.bg3}}>{o.label}</option>)}
              </select>
              <button onClick={() => removeRow(realIdx)} title="Remove"
                style={{background:'transparent', border:'none', color:T.text3, cursor:'pointer', fontSize:16, padding:'2px 6px', borderRadius:3, lineHeight:1}}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = T.red)}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = T.text3)}>
                ✕
              </button>
            </div>
          )
        })}
      </div>

      {/* Save bar */}
      <div style={{display:'flex', gap:12, alignItems:'center', padding:'12px 0', borderTop: dirty ? `1px solid ${T.amber}40` : 'none', position:'sticky', bottom:0, background:T.bg, paddingTop:12, marginTop:4}}>
        {dirty && <span style={{fontSize:12, color:T.amber}}>● Unsaved changes</span>}
        <div style={{flex:1}}/>
        <button onClick={() => load()} disabled={saving || !dirty}
          style={{padding:'8px 16px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor:(saving || !dirty) ? 'not-allowed' : 'pointer', opacity: dirty ? 1 : 0.4}}>
          Discard
        </button>
        <button onClick={save} disabled={saving || !dirty}
          style={{padding:'8px 20px', borderRadius:6, border:'none', background: dirty ? T.accent : T.bg3, color: dirty ? '#fff' : T.text3, fontSize:13, fontFamily:'inherit', cursor:(saving || !dirty) ? 'not-allowed' : 'pointer', fontWeight:600}}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

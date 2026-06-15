// components/workshop/JobTypesManager.tsx
// Job types (presets) manager — a named job with preset labour/parts, a work
// narrative, checklist, vehicle-model tags and attachable PDFs. Master-detail:
// the list of job types on the left, the selected one's editor on the right.
// Shared by the dedicated Jobs page and Settings → Workshop. Talks to
// /api/workshop/job-types, /job-type-lines and /vehicle-models.

import { useCallback, useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { useConfirm } from '../ui/Feedback'
import FilesPanel from './FilesPanel'

const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
const cellInp: React.CSSProperties = { ...inp, padding: '5px 7px', borderRadius: 4, fontSize: 12 }
function pbtn(color: string, solid?: boolean): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? color : 'transparent', color: solid ? '#fff' : color, border: `1px solid ${solid ? color : color + '55'}` }
}
const sectionLabel: React.CSSProperties = { fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '16px 0 6px' }

export default function JobTypesManager() {
  const [types, setTypes] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [newName, setNewName] = useState('')
  const [newModel, setNewModel] = useState('')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'jobtype' | 'models'>('jobtype')
  const confirmDialog = useConfirm()

  const loadModels = useCallback(async () => { try { const r = await fetch('/api/workshop/vehicle-models'); if (r.ok) setModels((await r.json()).models || []) } catch { /* */ } }, [])
  const load = useCallback(async () => { try { const r = await fetch('/api/workshop/job-types'); if (r.ok) setTypes((await r.json()).jobTypes || []) } catch { /* */ } }, [])
  useEffect(() => { load(); loadModels() }, [load, loadModels])
  // Auto-select the first job type on first load for convenience.
  useEffect(() => { if (!selectedId && view === 'jobtype' && types.length) setSelectedId(types[0].id) }, [types, selectedId, view])

  async function api(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await load()
  }
  async function modelApi(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await loadModels(); await load()
  }
  async function addType() {
    const n = newName.trim(); if (!n) return
    setNewName('')
    const r = await fetch('/api/workshop/job-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, sort_order: (types.length + 1) * 10 }) })
    try { const d = await r.json(); if (d?.jobType?.id) { setSelectedId(d.jobType.id); setView('jobtype') } } catch { /* */ }
    await load()
  }
  function addModel() { const n = newModel.trim(); if (!n) return; setNewModel(''); modelApi('/api/workshop/vehicle-models', 'POST', { name: n, sort_order: (models.length + 1) * 10 }) }
  function toggleModel(t: any, modelId: string) {
    const cur: string[] = t.model_ids || []
    const next = cur.includes(modelId) ? cur.filter(x => x !== modelId) : [...cur, modelId]
    setTypes(prev => prev.map(x => x.id === t.id ? { ...x, model_ids: next } : x))
    fetch(`/api/workshop/job-types?id=${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_ids: next }) }).catch(() => { /* surfaced on next load */ })
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? types.filter(t => `${t.name || ''} ${t.code || ''} ${t.description || ''}`.toLowerCase().includes(needle)) : types
  const selected = types.find(t => t.id === selectedId) || null

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* ── Left: list ── */}
      <div style={{ flex: '0 0 290px', maxWidth: '100%', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, boxSizing: 'border-box' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search job types…" style={{ ...inp, marginBottom: 10 }} />
        <div style={{ maxHeight: 520, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
          {shown.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '8px 4px' }}>{types.length === 0 ? 'No job types yet — add one below.' : `No matches for “${q}”.`}</div>}
          {shown.map(t => {
            const on = t.id === selectedId && view === 'jobtype'
            return (
              <button key={t.id} onClick={() => { setSelectedId(t.id); setView('jobtype') }} style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 8, marginBottom: 4, cursor: 'pointer', fontFamily: 'inherit',
                background: on ? `${T.accent}1f` : 'transparent', border: `1px solid ${on ? T.accent : 'transparent'}`, opacity: t.active ? 1 : 0.5,
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name || 'Untitled'}</div>
                <div style={{ fontSize: 10.5, color: T.text3 }}>{(t.lines || []).length} lines · {(t.model_ids || []).length} models{t.active ? '' : ' · inactive'}</div>
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New job type…" style={{ ...inp, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addType() }} />
          <button onClick={addType} style={pbtn(T.accent, true)}>+ Add</button>
        </div>
        <button onClick={() => setView('models')} style={{ ...pbtn(view === 'models' ? T.blue : T.text3), width: '100%', marginTop: 8, background: view === 'models' ? `${T.blue}1a` : 'transparent' }}>🚗 Vehicle models</button>
      </div>

      {/* ── Right: editor ── */}
      <div style={{ flex: '1 1 380px', minWidth: 320, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18, boxSizing: 'border-box' }}>
        {view === 'models' ? (
          <ModelsEditor models={models} newModel={newModel} setNewModel={setNewModel} addModel={addModel}
            onDelete={async (m) => { if (await confirmDialog({ title: `Delete model “${m.name}”?`, message: 'It’s removed from all job types and vehicles.', danger: true })) modelApi(`/api/workshop/vehicle-models/${m.id}`, 'DELETE') }} />
        ) : !selected ? (
          <div style={{ padding: '40px 8px', textAlign: 'center', color: T.text3, fontSize: 13 }}>Select a job type on the left to edit it, or add a new one.</div>
        ) : (
          <div key={selected.id}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input defaultValue={selected.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== selected.name) api(`/api/workshop/job-types?id=${selected.id}`, 'PATCH', { name: v }) }} style={{ ...inp, flex: 1, fontWeight: 600, fontSize: 15 }} />
              <label style={{ fontSize: 12, color: T.text2, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}><input type="checkbox" checked={!!selected.active} onChange={e => api(`/api/workshop/job-types?id=${selected.id}`, 'PATCH', { active: e.target.checked })} />Active</label>
              <button onClick={async () => { if (await confirmDialog({ title: `Delete job type “${selected.name}”?`, danger: true })) { await api(`/api/workshop/job-types?id=${selected.id}`, 'DELETE'); setSelectedId(null) } }} style={pbtn(T.red)}>Delete</button>
            </div>

            {/* Vehicle models */}
            <div style={sectionLabel}>Vehicle models this job applies to</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {(selected.model_ids || []).map((mid: string) => { const m = models.find(x => x.id === mid); if (!m) return null; return (
                <span key={mid} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 9px', background: `${T.blue}22`, border: `1px solid ${T.blue}`, color: T.blue, borderRadius: 10, fontSize: 11 }}>
                  {m.name}<button onClick={() => toggleModel(selected, mid)} title="Remove" style={{ background: 'none', border: 'none', color: T.blue, cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
                </span>
              )})}
              {models.filter(m => !(selected.model_ids || []).includes(m.id)).length > 0 ? (
                <select value="" onChange={e => { if (e.target.value) toggleModel(selected, e.target.value) }} style={{ ...cellInp, width: 'auto' }}>
                  <option value="">+ Add model…</option>
                  {models.filter(m => !(selected.model_ids || []).includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              ) : models.length === 0 ? <button onClick={() => setView('models')} style={{ ...pbtn(T.text3), padding: '4px 10px' }}>Add models…</button> : null}
            </div>

            {/* Description */}
            <div style={sectionLabel}>Invoice description (work narrative)</div>
            <textarea defaultValue={selected.description || ''} onBlur={e => { const v = e.target.value; if (v !== (selected.description || '')) api(`/api/workshop/job-types?id=${selected.id}`, 'PATCH', { description: v }) }} rows={3} placeholder="e.g. Carry out 300 Series 100,000km logbook service per schedule…" style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />

            {/* Checklist */}
            <div style={sectionLabel}>Checklist (copied onto the job card when applied)</div>
            <JobTypeChecklist items={selected.checklist || []} onSave={items => api(`/api/workshop/job-types?id=${selected.id}`, 'PATCH', { checklist: items })} />

            {/* Line items */}
            <div style={sectionLabel}>Invoice line items (parts & labour)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 50px 80px 26px', gap: 6, padding: '4px 2px', fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em' }}><div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div /></div>
            {(selected.lines || []).map((l: any) => <JobTypeLineRow key={l.id} line={l} onPatch={(p: any) => api(`/api/workshop/job-type-lines?id=${l.id}`, 'PATCH', p)} onRemove={() => api(`/api/workshop/job-type-lines?id=${l.id}`, 'DELETE')} />)}
            {(selected.lines || []).length === 0 && <div style={{ fontSize: 11, color: T.text3, padding: '4px 2px' }}>No lines yet — add labour, a fee or parts below.</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: selected.id, line_type: 'labour', description: 'Labour', qty: 1, unit_price_ex_gst: 0, sort_order: (selected.lines || []).length })} style={pbtn(T.blue)}>+ Labour</button>
              <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: selected.id, line_type: 'fee', description: '', qty: 1, unit_price_ex_gst: 0, sort_order: (selected.lines || []).length })} style={pbtn(T.blue)}>+ Fee</button>
              <JTPartPicker onPick={(it: any) => api('/api/workshop/job-type-lines', 'POST', { job_type_id: selected.id, line_type: 'part', description: it.part_name, part_number: it.sku, qty: 1, unit_price_ex_gst: Number(it.sell_price) || 0, inventory_id: it.id, sort_order: (selected.lines || []).length })} />
            </div>

            {/* Attachments */}
            <div style={sectionLabel}>Attachments (PDFs offered when emailing this job type)</div>
            <FilesPanel jobTypeId={selected.id} canEdit={true} />
          </div>
        )}
      </div>
    </div>
  )
}

function ModelsEditor({ models, newModel, setNewModel, addModel, onDelete }: { models: any[]; newModel: string; setNewModel: (v: string) => void; addModel: () => void; onDelete: (m: any) => void }) {
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Vehicle models</div>
      <div style={{ fontSize: 12, color: T.text3, marginBottom: 14 }}>Tag job types with models so the diary only offers the jobs relevant to a vehicle.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {models.map(m => (
          <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 12 }}>
            {m.name}<button onClick={() => onDelete(m)} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
          </span>
        ))}
        {models.length === 0 && <span style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>No models yet — add e.g. “200 Series”, “79 Series”, “300 Series”.</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder="New model (e.g. 300 Series)" style={{ ...inp, flex: 1, maxWidth: 300 }} onKeyDown={e => { if (e.key === 'Enter') addModel() }} />
        <button onClick={addModel} style={pbtn(T.blue)}>+ Add model</button>
      </div>
    </div>
  )
}

function JobTypeLineRow({ line, onPatch, onRemove }: { line: any; onPatch: (p: any) => void; onRemove: () => void }) {
  const [desc, setDesc] = useState(line.description || '')
  const [qty, setQty] = useState(String(line.qty))
  const [price, setPrice] = useState(String(line.unit_price_ex_gst))
  useEffect(() => { setDesc(line.description || ''); setQty(String(line.qty)); setPrice(String(line.unit_price_ex_gst)) }, [line.id, line.description, line.qty, line.unit_price_ex_gst])
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 50px 80px 26px', gap: 6, padding: '4px 2px', alignItems: 'center' }}>
      <span style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase' }}>{line.line_type}</span>
      <input value={desc} onChange={e => setDesc(e.target.value)} onBlur={() => desc !== (line.description || '') && onPatch({ description: desc })} placeholder={line.part_number || 'Description'} style={cellInp} />
      <input value={qty} inputMode="decimal" onChange={e => setQty(e.target.value)} onBlur={() => Number(qty) !== Number(line.qty) && onPatch({ qty: Number(qty) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <input value={price} inputMode="decimal" onChange={e => setPrice(e.target.value)} onBlur={() => Number(price) !== Number(line.unit_price_ex_gst) && onPatch({ unit_price_ex_gst: Number(price) || 0 })} style={{ ...cellInp, textAlign: 'right' }} />
      <button onClick={onRemove} title="Remove" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
    </div>
  )
}

function JobTypeChecklist({ items, onSave }: { items: string[]; onSave: (items: string[]) => void }) {
  const [list, setList] = useState<string[]>(Array.isArray(items) ? items : [])
  const [add, setAdd] = useState('')
  useEffect(() => { setList(Array.isArray(items) ? items : []) }, [JSON.stringify(items)])  // eslint-disable-line react-hooks/exhaustive-deps
  function commit(next: string[]) { setList(next); onSave(next) }
  return (
    <div>
      {list.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: T.text3, fontSize: 12 }}>☐</span>
          <input defaultValue={it} onBlur={e => { const v = e.target.value.trim(); if (v !== it) { const next = [...list]; if (v) next[i] = v; else next.splice(i, 1); commit(next) } }} style={{ ...cellInp, flex: 1 }} />
          <button onClick={() => commit(list.filter((_, idx) => idx !== i))} title="Remove" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
        </div>
      ))}
      <input value={add} onChange={e => setAdd(e.target.value)} placeholder="+ Add checklist item (press Enter)" onKeyDown={e => { if (e.key === 'Enter' && add.trim()) { commit([...list, add.trim()]); setAdd('') } }} style={{ ...cellInp, width: '100%' }} />
    </div>
  )
}

function JTPartPicker({ onPick }: { onPick: (item: any) => void }) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([])
  useEffect(() => { if (!open) return; const t = setTimeout(async () => { try { const r = await fetch(`/api/workshop/inventory?q=${encodeURIComponent(q)}`); setResults((await r.json()).items || []) } catch { /* */ } }, 250); return () => clearTimeout(t) }, [q, open])
  if (!open) return <button onClick={() => setOpen(true)} style={pbtn(T.blue)}>+ Part</button>
  return (
    <div style={{ position: 'relative' }}>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search parts…" onBlur={() => setTimeout(() => setOpen(false), 200)} style={{ ...cellInp, width: 200 }} />
      {results.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 0, width: 260, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, marginBottom: 4, maxHeight: 220, overflowY: 'auto', zIndex: 10 }}>
          {results.map((it: any) => <div key={it.id} onMouseDown={() => { onPick(it); setOpen(false); setQ('') }} style={{ padding: '7px 10px', fontSize: 12, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}><div style={{ color: T.text }}>{it.part_name}</div><div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{it.sku || ''}</div></div>)}
        </div>
      )}
    </div>
  )
}

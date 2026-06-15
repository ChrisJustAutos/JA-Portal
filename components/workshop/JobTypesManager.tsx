// components/workshop/JobTypesManager.tsx
// Job types (presets) manager — a named job with preset labour/parts, a work
// narrative, checklist, vehicle-model tags and attachable PDFs. Shared by the
// dedicated Jobs page (full-width) and Settings → Workshop. Talks to
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

export default function JobTypesManager() {
  const [types, setTypes] = useState<any[]>([])
  const [models, setModels] = useState<any[]>([])
  const [newName, setNewName] = useState('')
  const [newModel, setNewModel] = useState('')
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const confirmDialog = useConfirm()
  const loadModels = useCallback(async () => { try { const r = await fetch('/api/workshop/vehicle-models'); if (r.ok) setModels((await r.json()).models || []) } catch { /* */ } }, [])
  const load = useCallback(async () => { try { const r = await fetch('/api/workshop/job-types'); if (r.ok) setTypes((await r.json()).jobTypes || []) } catch { /* */ } }, [])
  useEffect(() => { load(); loadModels() }, [load, loadModels])
  async function api(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await load()
  }
  async function modelApi(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await loadModels(); await load()
  }
  function addType() { const n = newName.trim(); if (!n) return; setNewName(''); api('/api/workshop/job-types', 'POST', { name: n, sort_order: (types.length + 1) * 10 }) }
  function addModel() { const n = newModel.trim(); if (!n) return; setNewModel(''); modelApi('/api/workshop/vehicle-models', 'POST', { name: n, sort_order: (models.length + 1) * 10 }) }
  function toggleModel(t: any, modelId: string) {
    const cur: string[] = t.model_ids || []
    const next = cur.includes(modelId) ? cur.filter(x => x !== modelId) : [...cur, modelId]
    setTypes(prev => prev.map(x => x.id === t.id ? { ...x, model_ids: next } : x))
    fetch(`/api/workshop/job-types?id=${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_ids: next }) }).catch(() => { /* surfaced on next load */ })
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? types.filter(t => `${t.name || ''} ${t.code || ''} ${t.description || ''}`.toLowerCase().includes(needle)) : types

  return (
    <div>
      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Job types (presets)</div>
          <span style={{ flex: 1 }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search job types…" style={{ ...inp, width: 220 }} />
        </div>
        <div style={{ fontSize: 12, color: T.text3, marginBottom: 12 }}>A job type is a named job with preset labour + parts. Apply it on a job card or quote to fill the lines in one click.</div>

        {/* Vehicle models */}
        <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 11, color: T.text2, fontWeight: 600, marginBottom: 6 }}>Vehicle models <span style={{ color: T.text3, fontWeight: 400 }}>— tag job types with models so the diary only offers the jobs relevant to a vehicle.</span></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {models.map(m => (
              <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 4, fontSize: 11 }}>
                {m.name}
                <button onClick={async () => { if (await confirmDialog({ title: `Delete model “${m.name}”?`, message: 'It’s removed from all job types and vehicles.', danger: true })) modelApi(`/api/workshop/vehicle-models/${m.id}`, 'DELETE') }} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>×</button>
              </span>
            ))}
            {models.length === 0 && <span style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>No models yet — add e.g. “200 Series”, “79 Series”, “300 Series”.</span>}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder="New model (e.g. 300 Series)" style={{ ...inp, flex: 1, maxWidth: 260 }} onKeyDown={e => { if (e.key === 'Enter') addModel() }} />
            <button onClick={addModel} style={pbtn(T.blue)}>+ Add model</button>
          </div>
        </div>

        {types.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '4px 0 12px' }}>No job types yet — add one below, or import from MechanicDesk.</div>}
        {shown.map(t => (
          <div key={t.id} style={{ border: `1px solid ${T.border}`, borderRadius: 8, marginBottom: 8, background: T.bg3, opacity: t.active ? 1 : 0.55 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
              <input defaultValue={t.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== t.name) api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { name: v }) }} style={{ ...cellInp, flex: 1, fontWeight: 600 }} />
              <label style={{ fontSize: 11, color: T.text2, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={!!t.active} onChange={e => api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { active: e.target.checked })} />Active</label>
              <span style={{ fontSize: 11, color: T.text3, whiteSpace: 'nowrap' }}>{(t.lines || []).length} lines · {(t.model_ids || []).length} models</span>
              <button onClick={() => setOpenId(openId === t.id ? null : t.id)} style={pbtn(T.blue)}>{openId === t.id ? 'Close' : 'Edit'}</button>
              <button onClick={async () => { if (await confirmDialog({ title: `Delete job type “${t.name}”?`, danger: true })) api(`/api/workshop/job-types?id=${t.id}`, 'DELETE') }} title="Delete" style={{ background: 'transparent', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>
            {openId === t.id && (
              <div style={{ padding: '0 10px 10px' }}>
                {models.length > 0 && (
                  <>
                    <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '2px 0 4px' }}>Vehicle models this job applies to</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 12 }}>
                      {(t.model_ids || []).map((mid: string) => { const m = models.find(x => x.id === mid); if (!m) return null; return (
                        <span key={mid} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 9px', background: `${T.blue}22`, border: `1px solid ${T.blue}`, color: T.blue, borderRadius: 10, fontSize: 11 }}>
                          {m.name}
                          <button onClick={() => toggleModel(t, mid)} title="Remove" style={{ background: 'none', border: 'none', color: T.blue, cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
                        </span>
                      )})}
                      {(t.model_ids || []).length === 0 && <span style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>No models — won’t show in the diary under strict filtering.</span>}
                      {models.filter(m => !(t.model_ids || []).includes(m.id)).length > 0 && (
                        <select value="" onChange={e => { if (e.target.value) toggleModel(t, e.target.value) }} style={{ ...cellInp, width: 'auto' }}>
                          <option value="">+ Add model…</option>
                          {models.filter(m => !(t.model_ids || []).includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      )}
                    </div>
                  </>
                )}
                <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '2px 0 4px' }}>Invoice description (work narrative on the invoice)</div>
                <textarea defaultValue={t.description || ''} onBlur={e => { const v = e.target.value; if (v !== (t.description || '')) api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { description: v }) }} rows={3} placeholder="e.g. Carry out 300 Series 100,000km logbook service per schedule…" style={{ ...inp, width: '100%', resize: 'vertical', marginBottom: 12, fontFamily: 'inherit' }} />

                <JobTypeChecklist items={t.checklist || []} onSave={items => api(`/api/workshop/job-types?id=${t.id}`, 'PATCH', { checklist: items })} />

                <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '6px 0 4px' }}>Invoice line items</div>
                <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 50px 80px 26px', gap: 6, padding: '4px 2px', fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em' }}><div>Type</div><div>Description</div><div style={{ textAlign: 'right' }}>Qty</div><div style={{ textAlign: 'right' }}>Unit ex</div><div /></div>
                {(t.lines || []).map((l: any) => <JobTypeLineRow key={l.id} line={l} onPatch={(p: any) => api(`/api/workshop/job-type-lines?id=${l.id}`, 'PATCH', p)} onRemove={() => api(`/api/workshop/job-type-lines?id=${l.id}`, 'DELETE')} />)}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'labour', description: 'Labour', qty: 1, unit_price_ex_gst: 0, sort_order: (t.lines || []).length })} style={pbtn(T.blue)}>+ Labour</button>
                  <button onClick={() => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'fee', description: '', qty: 1, unit_price_ex_gst: 0, sort_order: (t.lines || []).length })} style={pbtn(T.blue)}>+ Fee</button>
                  <JTPartPicker onPick={(it: any) => api('/api/workshop/job-type-lines', 'POST', { job_type_id: t.id, line_type: 'part', description: it.part_name, part_number: it.sku, qty: 1, unit_price_ex_gst: Number(it.sell_price) || 0, inventory_id: it.id, sort_order: (t.lines || []).length })} />
                </div>

                <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 0' }}>Attachments (PDFs offered when emailing this job type)</div>
                <FilesPanel jobTypeId={t.id} canEdit={true} />
              </div>
            )}
          </div>
        ))}
        {needle && shown.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '4px 0 12px' }}>No job types match “{q}”.</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New job type (e.g. Logbook Service)" style={{ ...inp, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addType() }} />
          <button onClick={addType} style={pbtn(T.accent, true)}>+ Add</button>
        </div>
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
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 4px' }}>Checklist (copied onto the job card when applied)</div>
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

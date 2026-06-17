// components/workshop/PackagesManager.tsx
// Define job-type PACKAGES — a named, ordered bundle of existing job types
// (e.g. "Stage 1 Tune Package"). Master-detail like JobTypesManager. Applying a
// package (from the quote builder / job page) drops each member job type's
// block in order. Talks to /api/workshop/job-type-packages (+ /job-types for
// the member picker).

import { useCallback, useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { useConfirm } from '../ui/Feedback'

const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }
function pbtn(color: string, solid?: boolean): React.CSSProperties {
  return { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', background: solid ? color : 'transparent', color: solid ? '#fff' : color, border: `1px solid ${solid ? color : color + '55'}` }
}
const sectionLabel: React.CSSProperties = { fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '16px 0 6px' }

export default function PackagesManager() {
  const [packages, setPackages] = useState<any[]>([])
  const [jobTypes, setJobTypes] = useState<any[]>([])
  const [newName, setNewName] = useState('')
  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const confirmDialog = useConfirm()

  const load = useCallback(async () => { try { const r = await fetch('/api/workshop/job-type-packages'); if (r.ok) setPackages((await r.json()).packages || []) } catch { /* */ } }, [])
  useEffect(() => { load(); fetch('/api/workshop/job-types').then(r => r.json()).then(d => setJobTypes(d.jobTypes || [])).catch(() => undefined) }, [load])
  useEffect(() => { if (!selectedId && packages.length) setSelectedId(packages[0].id) }, [packages, selectedId])

  async function api(url: string, method: string, body?: any) {
    await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    await load()
  }
  async function addPackage() {
    const n = newName.trim(); if (!n) return
    setNewName('')
    const r = await fetch('/api/workshop/job-type-packages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, sort_order: (packages.length + 1) * 10 }) })
    try { const d = await r.json(); if (d?.package?.id) setSelectedId(d.package.id) } catch { /* */ }
    await load()
  }
  // Persist the ordered member list (job_type_ids) for the selected package.
  function setMembers(pkg: any, ids: string[]) {
    setPackages(prev => prev.map(p => p.id === pkg.id ? { ...p, items: ids.map((jid, i) => ({ job_type_id: jid, sort_order: i, name: jobTypes.find(t => t.id === jid)?.name || null })) } : p))
    fetch(`/api/workshop/job-type-packages?id=${pkg.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_type_ids: ids }) }).catch(() => undefined)
  }

  const needle = q.trim().toLowerCase()
  const shown = needle ? packages.filter(p => `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(needle)) : packages
  const selected = packages.find(p => p.id === selectedId) || null
  const memberIds: string[] = selected ? (selected.items || []).map((i: any) => i.job_type_id) : []
  const jtName = (id: string) => jobTypes.find(t => t.id === id)?.name || '(deleted job type)'

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Left: list */}
      <div style={{ flex: '0 0 340px', maxWidth: '100%', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, boxSizing: 'border-box' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search packages…" style={{ ...inp, marginBottom: 10 }} />
        <div style={{ maxHeight: 520, overflowY: 'auto', margin: '0 -4px', padding: '0 4px' }}>
          {shown.length === 0 && <div style={{ fontSize: 12, color: T.text3, padding: '8px 4px' }}>{packages.length === 0 ? 'No packages yet — add one below.' : `No matches for “${q}”.`}</div>}
          {shown.map(p => {
            const on = p.id === selectedId
            return (
              <button key={p.id} onClick={() => setSelectedId(p.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 8, marginBottom: 4, cursor: 'pointer', fontFamily: 'inherit', background: on ? `${T.purple}1f` : 'transparent', border: `1px solid ${on ? T.purple : 'transparent'}`, opacity: p.active === false ? 0.5 : 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name || 'Untitled'}</div>
                <div style={{ fontSize: 10.5, color: T.text3 }}>{(p.items || []).length} job type{(p.items || []).length === 1 ? '' : 's'}{p.active === false ? ' · inactive' : ''}</div>
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New package…" style={{ ...inp, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') addPackage() }} />
          <button onClick={addPackage} style={pbtn(T.purple, true)}>+ Add</button>
        </div>
      </div>

      {/* Right: editor */}
      <div style={{ flex: '1 1 520px', minWidth: 380, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 20, boxSizing: 'border-box' }}>
        {!selected ? (
          <div style={{ padding: '40px 8px', textAlign: 'center', color: T.text3, fontSize: 13 }}>Select a package on the left, or add a new one.</div>
        ) : (
          <div key={selected.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <input defaultValue={selected.name} onBlur={e => { const v = e.target.value.trim(); if (v && v !== selected.name) api(`/api/workshop/job-type-packages?id=${selected.id}`, 'PATCH', { name: v }) }} style={{ ...inp, flex: 1, fontWeight: 600, fontSize: 15 }} />
              <label style={{ fontSize: 12, color: T.text2, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}><input type="checkbox" checked={selected.active !== false} onChange={e => api(`/api/workshop/job-type-packages?id=${selected.id}`, 'PATCH', { active: e.target.checked })} />Active</label>
              <button onClick={async () => { if (await confirmDialog({ title: `Delete package “${selected.name}”?`, message: 'The member job types are not affected.', danger: true })) { await api(`/api/workshop/job-type-packages?id=${selected.id}`, 'DELETE'); setSelectedId(null) } }} style={pbtn(T.red)}>Delete</button>
            </div>

            <div style={sectionLabel}>Note (optional)</div>
            <textarea defaultValue={selected.description || ''} onBlur={e => { const v = e.target.value; if (v !== (selected.description || '')) api(`/api/workshop/job-type-packages?id=${selected.id}`, 'PATCH', { description: v }) }} rows={2} placeholder="Internal note, e.g. what this package is for." style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />

            <div style={sectionLabel}>Job types in this package (applied in this order)</div>
            {memberIds.length === 0 && <div style={{ fontSize: 11, color: T.text3, padding: '4px 2px' }}>No job types yet — add some below.</div>}
            {memberIds.map((jid, i) => (
              <div key={`${jid}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ width: 18, textAlign: 'right', color: T.text3, fontSize: 11 }}>{i + 1}.</span>
                <span style={{ flex: 1, fontSize: 13, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{jtName(jid)}</span>
                <button disabled={i === 0} onClick={() => { const next = [...memberIds]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; setMembers(selected, next) }} title="Move up" style={{ ...pbtn(T.text3), padding: '3px 8px', opacity: i === 0 ? 0.3 : 1 }}>↑</button>
                <button disabled={i === memberIds.length - 1} onClick={() => { const next = [...memberIds]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; setMembers(selected, next) }} title="Move down" style={{ ...pbtn(T.text3), padding: '3px 8px', opacity: i === memberIds.length - 1 ? 0.3 : 1 }}>↓</button>
                <button onClick={() => setMembers(selected, memberIds.filter((_, idx) => idx !== i))} title="Remove" style={{ background: 'transparent', border: 'none', color: T.red, cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
            ))}
            <div style={{ marginTop: 10 }}>
              <select value="" onChange={e => { if (e.target.value) setMembers(selected, [...memberIds, e.target.value]) }} style={{ ...inp, cursor: 'pointer' }}>
                <option value="">+ Add a job type…</option>
                {jobTypes.filter(t => t.active !== false).map(t => <option key={t.id} value={t.id}>{t.name}{t.code ? ` · ${t.code}` : ''}</option>)}
              </select>
              <div style={{ fontSize: 10.5, color: T.text3, marginTop: 6 }}>The same job type can be added more than once. Edit a job type’s lines under the “Job types” tab — packages always use the latest.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

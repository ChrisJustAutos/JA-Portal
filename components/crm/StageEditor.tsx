// components/crm/StageEditor.tsx
// Pipeline stage manager (crm_pipeline_stages): rename, recolour, reorder
// (HTML5 drag rows), add, archive-with-move, won/lost flags — plus the
// workshop-sync settings (quote status → stage map, value sync). Opened from
// the gear button on the pipeline board toolbar.

import { useEffect, useState } from 'react'
import { T } from './CrmShell'
import { Overlay, Field, input, primaryBtn, ghostBtn, closeBtn } from './ui'
import { useToast, useConfirm } from '../ui/Feedback'

export interface StageRow {
  id: string; key: string; label: string; color: string; sort_order: number
  on_board: boolean; is_won: boolean; is_lost: boolean; archived_at: string | null
}
interface Settings { quote_stage_map: Record<string, string>; sync_lead_value: boolean }

const SWATCHES = ['#4f8ef7', '#2dd4bf', '#a78bfa', '#fbbf24', '#34c77b', '#f04e4e', '#38bdf8', '#f472b6', '#fb923c', '#8b90a0']
const QUOTE_EVENTS: { key: string; label: string }[] = [
  { key: 'sent', label: 'Quote sent' },
  { key: 'accepted', label: 'Quote accepted' },
  { key: 'declined', label: 'Quote declined' },
  { key: 'converted', label: 'Quote converted to booking' },
]

export default function StageEditor({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [stages, setStages] = useState<StageRow[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)

  async function load() {
    const r = await fetch('/api/crm/stages')
    const d = await r.json()
    if (r.ok) { setStages(d.stages || []); setSettings(d.settings || null) }
  }
  useEffect(() => { load() }, [])

  const live = stages.filter(s => !s.archived_at)

  async function patchStage(id: string, patch: any) {
    const r = await fetch(`/api/crm/stages/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    if (!r.ok) toast((await r.json()).error || 'Save failed', 'error')
    await load(); onChanged()
  }
  async function addStage() {
    const label = newLabel.trim()
    if (!label) return
    setBusy(true)
    const r = await fetch('/api/crm/stages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) })
    if (!r.ok) toast((await r.json()).error || 'Create failed', 'error')
    setNewLabel(''); setBusy(false)
    await load(); onChanged()
  }
  async function archiveStage(s: StageRow) {
    const targets = live.filter(x => x.id !== s.id)
    if (!targets.length) return
    const moveTo = targets[0].key
    const ok = await confirmDialog({
      title: `Archive "${s.label}"?`,
      message: `Leads in this stage move to "${targets[0].label}" and automations referencing it are rewritten. The stage can't be un-archived from the UI.`,
      confirmLabel: 'Archive', danger: true,
    })
    if (!ok) return
    const r = await fetch(`/api/crm/stages/${s.id}?move_to=${encodeURIComponent(moveTo)}`, { method: 'DELETE' })
    if (!r.ok) toast((await r.json()).error || 'Archive failed', 'error')
    await load(); onChanged()
  }
  async function reorder(targetId: string) {
    if (!dragId || dragId === targetId) return
    const order = live.map(s => s.id)
    const from = order.indexOf(dragId), to = order.indexOf(targetId)
    if (from < 0 || to < 0) return
    order.splice(to, 0, order.splice(from, 1)[0])
    setStages(prev => {
      const by: Record<string, StageRow> = {}; prev.forEach(s => { by[s.id] = s })
      return order.map(idd => by[idd]).concat(prev.filter(s => s.archived_at)) as StageRow[]
    })
    await fetch('/api/crm/stages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order }) })
    await load(); onChanged()
  }
  async function saveSettings(patch: Partial<Settings>) {
    const next = { ...settings!, ...patch }
    setSettings(next)
    await fetch('/api/crm/stages', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: next }) })
    onChanged()
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>Pipeline stages</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {live.map(s => (
          <div key={s.id} draggable
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); reorder(s.id) }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', opacity: dragId === s.id ? 0.4 : 1 }}>
            <span title="Drag to reorder" style={{ cursor: 'grab', color: T.text3, fontSize: 13 }}>⠿</span>
            <ColorDot color={s.color} onPick={c => patchStage(s.id, { color: c })} />
            <input defaultValue={s.label} onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== s.label) patchStage(s.id, { label: e.target.value.trim() }) }}
              style={{ ...input, width: 'auto', flex: 1, padding: '4px 8px', fontSize: 12, background: 'transparent', border: `1px solid transparent` }} />
            <Toggle on={s.on_board} label="board" title="Show as a column on the kanban" onClick={() => patchStage(s.id, { on_board: !s.on_board })} />
            <Toggle on={s.is_won} label="won" title="Leads here count as won (stamps won_at)" onClick={() => patchStage(s.id, { is_won: !s.is_won })} color={T.green} />
            <Toggle on={s.is_lost} label="lost" title="Leads here count as lost (stamps lost_at)" onClick={() => patchStage(s.id, { is_lost: !s.is_lost })} color={T.red} />
            <button onClick={() => archiveStage(s)} title="Archive stage (moves its leads first)" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 14 }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
        <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="+ Add stage…" onKeyDown={e => { if (e.key === 'Enter') addStage() }} style={{ ...input, flex: 1 }} />
        <button onClick={addStage} disabled={busy || !newLabel.trim()} style={primaryBtn}>Add</button>
      </div>

      {settings && (
        <>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Workshop quote sync</div>
          <div style={{ fontSize: 11, color: T.text3, marginBottom: 10, lineHeight: 1.5 }}>
            When a linked workshop quote changes status, move the lead to…
          </div>
          {QUOTE_EVENTS.map(ev => (
            <Field key={ev.key} label={ev.label}>
              <select value={settings.quote_stage_map[ev.key] || ''} onChange={e => saveSettings({ quote_stage_map: { ...settings.quote_stage_map, [ev.key]: e.target.value } })} style={input}>
                <option value="">— don't move the lead —</option>
                {live.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
          ))}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: T.text2, cursor: 'pointer', marginTop: 4 }}>
            <input type="checkbox" checked={settings.sync_lead_value} onChange={e => saveSettings({ sync_lead_value: e.target.checked })} />
            Keep the lead's value in sync with the quote total
          </label>
        </>
      )}
    </Overlay>
  )
}

function ColorDot({ color, onPick }: { color: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} title="Stage colour"
        style={{ width: 16, height: 16, borderRadius: '50%', background: color, border: `2px solid ${T.bg2}`, boxShadow: `0 0 0 1px ${color}`, cursor: 'pointer', padding: 0 }} />
      {open && (
        <span style={{ position: 'absolute', top: 20, left: 0, zIndex: 20, display: 'flex', gap: 4, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 6 }}>
          {SWATCHES.map(c => (
            <button key={c} onClick={() => { onPick(c); setOpen(false) }}
              style={{ width: 14, height: 14, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer', padding: 0 }} />
          ))}
        </span>
      )}
    </span>
  )
}

function Toggle({ on, label, title, onClick, color }: { on: boolean; label: string; title: string; onClick: () => void; color?: string }) {
  const c = color || T.blue
  return (
    <button onClick={onClick} title={title} style={{
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
      padding: '3px 7px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
      background: on ? `${c}26` : 'transparent', color: on ? c : T.text3,
      border: `1px solid ${on ? c : T.border2}`,
    }}>{label}</button>
  )
}

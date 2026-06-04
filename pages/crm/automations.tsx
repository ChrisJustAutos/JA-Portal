// pages/crm/automations.tsx — CRM automation sequences (Phase 2). Define
// time-based follow-up steps (email / SMS / task / owner notification) that
// fire when a lead is created or moves to a stage.
import { useState, useEffect, useCallback } from 'react'
import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T } from '../../components/crm/CrmShell'
import { Overlay, Field, input, primaryBtn, ghostBtn, closeBtn } from '../../components/crm/ui'
import { LEAD_STAGES, LEAD_STAGE_LABELS, LeadStage } from '../../lib/crm'

interface Step { delay_value: number; delay_unit: 'days' | 'hours'; action: string; subject: string; body: string; task_priority: string }
interface Automation {
  id: string; name: string; description: string | null; trigger_event: string; trigger_stage: string | null
  enabled: boolean; cancel_on_stages: string[]; steps: any[]
}
const ACTION_LABELS: Record<string, string> = { email: 'Send email', sms: 'Send SMS', task: 'Create task', notify_owner: 'Notify owner' }
const VARS = ['first_name', 'contact_name', 'vehicle', 'lead_title', 'value', 'owner_name', 'company']

function hoursToStep(s: any): Step {
  const h = Number(s.delay_hours) || 0
  const days = h % 24 === 0
  return { delay_value: days ? h / 24 : h, delay_unit: days ? 'days' : 'hours', action: s.action || 'email', subject: s.subject || '', body: s.body || '', task_priority: s.task_priority || 'normal' }
}
function stepToHours(s: Step): number { return Math.max(0, Math.round(s.delay_value * (s.delay_unit === 'days' ? 24 : 1))) }

export default function CrmAutomations({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:crm')
  const [autos, setAutos] = useState<Automation[]>([])
  const [counts, setCounts] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Automation | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/crm/automations'); const d = await r.json()
      if (r.ok) { setAutos(d.automations || []); setCounts(d.counts || {}) }
    } catch { /* keep */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function toggle(a: Automation) {
    setAutos(prev => prev.map(x => x.id === a.id ? { ...x, enabled: !x.enabled } : x))
    await fetch(`/api/crm/automations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !a.enabled }) })
    load()
  }
  async function remove(a: Automation) {
    if (!confirm(`Delete automation "${a.name}"? Active enrolments will stop.`)) return
    await fetch(`/api/crm/automations/${a.id}`, { method: 'DELETE' }); load()
  }
  function newAutomation() {
    setEditing({ id: '', name: '', description: '', trigger_event: 'stage_changed', trigger_stage: 'quoted', enabled: false, cancel_on_stages: ['won', 'lost'], steps: [] })
  }

  function triggerSummary(a: Automation) {
    if (a.trigger_event === 'lead_created') return a.trigger_stage ? `When a lead is created at "${LEAD_STAGE_LABELS[a.trigger_stage as LeadStage] || a.trigger_stage}"` : 'When any lead is created'
    return `When a lead moves to "${LEAD_STAGE_LABELS[a.trigger_stage as LeadStage] || a.trigger_stage || 'a stage'}"`
  }

  return (
    <CrmShell user={user} active="automations" title="Automations">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Automations</h1>
          <span style={{ flex: 1 }} />
          {loading && <span style={{ color: T.text3, fontSize: 12, fontStyle: 'italic' }}>Loading…</span>}
          {canEdit && <button onClick={newAutomation} style={primaryBtn}>+ New automation</button>}
        </div>
        <p style={{ fontSize: 12.5, color: T.text2, margin: '0 0 18px', lineHeight: 1.5 }}>
          Sequences run on their own once enabled — e.g. email a contact 3 days after a quote, SMS at 7 days, then raise a call task. They stop automatically when the lead is won or lost (or the contact is marked do-not-contact). Runs hourly.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {autos.map(a => {
            const c = counts[a.id] || {}
            return (
              <div key={a.id} style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600 }}>{a.name}</span>
                      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: a.enabled ? 'rgba(52,199,123,0.16)' : T.bg3, color: a.enabled ? T.green : T.text3, border: `1px solid ${a.enabled ? T.green + '40' : T.border2}` }}>{a.enabled ? 'Active' : 'Off'}</span>
                    </div>
                    <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{triggerSummary(a)} · {a.steps.length} step{a.steps.length === 1 ? '' : 's'}</div>
                    {a.description && <div style={{ fontSize: 12, color: T.text3, marginTop: 4 }}>{a.description}</div>}
                    <div style={{ fontSize: 11, color: T.text3, marginTop: 6, fontFamily: 'monospace' }}>{c.active || 0} active · {c.done || 0} completed · {c.cancelled || 0} stopped</div>
                  </div>
                  {canEdit && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={a.enabled} onChange={() => toggle(a)} /> Enabled
                      </label>
                      <button onClick={() => setEditing({ ...a })} style={ghostBtn}>Edit</button>
                      <button onClick={() => remove(a)} style={{ ...ghostBtn, color: T.red, borderColor: 'transparent' }}>Delete</button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {!loading && autos.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: T.text3, fontSize: 13 }}>No automations yet.</div>}
        </div>
      </div>

      {editing && <Editor automation={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </CrmShell>
  )
}

function Editor({ automation, onClose, onSaved }: { automation: Automation; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(automation.name)
  const [description, setDescription] = useState(automation.description || '')
  const [triggerEvent, setTriggerEvent] = useState(automation.trigger_event)
  const [triggerStage, setTriggerStage] = useState(automation.trigger_stage || '')
  const [cancelStages, setCancelStages] = useState<string[]>(automation.cancel_on_stages || ['won', 'lost'])
  const [steps, setSteps] = useState<Step[]>((automation.steps || []).map(hoursToStep))
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')

  function updateStep(i: number, patch: Partial<Step>) { setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s)) }
  function addStep() { setSteps(prev => [...prev, { delay_value: prev.length ? 3 : 0, delay_unit: 'days', action: 'email', subject: '', body: '', task_priority: 'normal' }]) }
  function removeStep(i: number) { setSteps(prev => prev.filter((_, idx) => idx !== i)) }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps(prev => { const a = [...prev]; const j = i + dir; if (j < 0 || j >= a.length) return prev;[a[i], a[j]] = [a[j], a[i]]; return a })
  }
  function toggleCancel(stage: string) { setCancelStages(prev => prev.includes(stage) ? prev.filter(s => s !== stage) : [...prev, stage]) }

  async function save() {
    if (!name.trim()) { setErr('Name required'); return }
    setBusy(true); setErr('')
    const payload = {
      name, description, trigger_event: triggerEvent,
      trigger_stage: triggerStage || null, cancel_on_stages: cancelStages,
      steps: steps.map(s => ({ delay_hours: stepToHours(s), action: s.action, subject: s.subject, body: s.body, task_priority: s.task_priority })),
    }
    try {
      const r = automation.id
        ? await fetch(`/api/crm/automations/${automation.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/crm/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json()
      if (r.ok) onSaved(); else setErr(d.error || 'Failed')
    } catch { setErr('Network error') } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{automation.id ? 'Edit automation' : 'New automation'}</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>

      <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} style={input} placeholder="e.g. Quote follow-up" /></Field>
      <Field label="Description"><input value={description} onChange={e => setDescription(e.target.value)} style={input} /></Field>

      <Field label="Trigger">
        <select value={triggerEvent} onChange={e => setTriggerEvent(e.target.value)} style={{ ...input, marginBottom: 6 }}>
          <option value="lead_created">When a lead is created</option>
          <option value="stage_changed">When a lead moves to a stage</option>
        </select>
        <select value={triggerStage} onChange={e => setTriggerStage(e.target.value)} style={input}>
          <option value="">{triggerEvent === 'lead_created' ? 'Any stage' : 'Choose a stage…'}</option>
          {LEAD_STAGES.map(s => <option key={s} value={s}>{LEAD_STAGE_LABELS[s as LeadStage]}</option>)}
        </select>
      </Field>

      <Field label="Stop the sequence if the lead reaches">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {LEAD_STAGES.map(s => (
            <button key={s} onClick={() => toggleCancel(s)} style={{
              fontSize: 11, padding: '4px 9px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              background: cancelStages.includes(s) ? 'rgba(240,78,78,0.16)' : 'transparent',
              color: cancelStages.includes(s) ? T.red : T.text3, border: `1px solid ${cancelStages.includes(s) ? T.red + '55' : T.border2}`,
            }}>{LEAD_STAGE_LABELS[s as LeadStage]}</button>
          ))}
        </div>
      </Field>

      <div style={{ fontSize: 11, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 8px' }}>Steps</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: T.text3 }}>Step {i + 1} · after</span>
              <input type="number" min={0} value={s.delay_value} onChange={e => updateStep(i, { delay_value: Number(e.target.value) })} style={{ ...input, width: 64, padding: '4px 6px' }} />
              <select value={s.delay_unit} onChange={e => updateStep(i, { delay_unit: e.target.value as any })} style={{ ...input, width: 90, padding: '4px 6px' }}>
                <option value="days">days</option><option value="hours">hours</option>
              </select>
              <span style={{ flex: 1 }} />
              <button onClick={() => moveStep(i, -1)} disabled={i === 0} style={miniBtn} title="Move up">↑</button>
              <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} style={miniBtn} title="Move down">↓</button>
              <button onClick={() => removeStep(i)} style={{ ...miniBtn, color: T.red }} title="Remove">✕</button>
            </div>
            <select value={s.action} onChange={e => updateStep(i, { action: e.target.value })} style={{ ...input, marginBottom: 8 }}>
              {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {s.action !== 'sms' && (
              <input value={s.subject} onChange={e => updateStep(i, { subject: e.target.value })} placeholder={s.action === 'task' ? 'Task title' : s.action === 'notify_owner' ? 'Notification title' : 'Email subject'} style={{ ...input, marginBottom: 8 }} />
            )}
            <textarea value={s.body} onChange={e => updateStep(i, { body: e.target.value })} placeholder={s.action === 'sms' ? 'SMS text' : s.action === 'task' ? 'Task description' : s.action === 'notify_owner' ? 'Message' : 'Email body'} style={{ ...input, minHeight: 70, resize: 'vertical' }} />
            {s.action === 'task' && (
              <select value={s.task_priority} onChange={e => updateStep(i, { task_priority: e.target.value })} style={{ ...input, marginTop: 8, width: 140 }}>
                {['low', 'normal', 'high', 'urgent'].map(p => <option key={p} value={p}>{p} priority</option>)}
              </select>
            )}
          </div>
        ))}
        <button onClick={addStep} style={{ ...ghostBtn, borderStyle: 'dashed', width: '100%', padding: '8px' }}>+ Add step</button>
      </div>

      <div style={{ fontSize: 11, color: T.text3, margin: '12px 0', lineHeight: 1.6 }}>
        Placeholders you can use in subjects/bodies:<br />
        {VARS.map(v => <code key={v} style={{ background: T.bg3, padding: '1px 5px', borderRadius: 3, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}
      </div>

      {err && <div style={{ color: T.red, fontSize: 12, marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={save} disabled={busy} style={primaryBtn}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Overlay>
  )
}

const miniBtn: React.CSSProperties = { background: 'transparent', border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 5, fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}

// components/settings/CoachingTab.tsx
//
// Settings → Coaching: edit the call-coaching rubrics from the portal (no SQL
// required) and manage the advisor roster used for transcript-based call
// attribution.
//
// A rubric = shared company context + prompt template + CALL TYPES, each type
// with its own weighted dimension set (weights should total 10 → score /100).
// Exactly one rubric is active; the analyser reads it on every run, so edits
// to the active rubric apply from the next cron tick — no deploy needed.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, StatusPill, inp, pbtn, miniBtn, T } from '../ui'
import { useToast, useConfirm, usePrompt } from '../ui/Feedback'

interface Dimension { id: string; label: string; weight: number; description: string; anchors?: string }
interface CallType { id: string; label: string; description: string; scoreable: boolean; dimensions?: Dimension[] }
interface Rubric {
  version: string
  description: string | null
  is_active: boolean
  prompt_template: string
  company_context: string | null
  call_types: CallType[] | null
}
interface RosterRow { id: string; name: string; aliases: string[]; slack_user_id: string | null; extensions: string[]; active: boolean }

const lbl: React.CSSProperties = { fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }
const ta: React.CSSProperties = { ...inp, width: '100%', minHeight: 120, fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5, resize: 'vertical' }

export default function CoachingTab() {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const promptDialog = usePrompt()

  const [rubrics, setRubrics] = useState<Rubric[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Rubric | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/settings/coaching-rubrics').then(r => r.json()),
        fetch('/api/settings/coaching-roster').then(r => r.json()),
      ])
      const rs: Rubric[] = r1.rubrics || []
      setRubrics(rs)
      setRoster(r2.roster || [])
      // Keep the current selection when it still exists; default = active rubric.
      setSelected(prev => (prev && rs.some(r => r.version === prev)) ? prev : (rs.find(r => r.is_active)?.version || rs[0]?.version || null))
    } catch (e: any) {
      toast(e?.message || 'Failed to load rubrics', 'error')
    } finally { setLoading(false) }
  }, [toast])
  useEffect(() => { load() }, [load])

  // Draft = deep copy of the selected rubric for editing.
  useEffect(() => {
    const r = rubrics.find(x => x.version === selected)
    setDraft(r ? JSON.parse(JSON.stringify(r)) : null)
    setShowPrompt(false)
  }, [selected, rubrics])

  const dirty = useMemo(() => {
    const r = rubrics.find(x => x.version === selected)
    return !!draft && !!r && JSON.stringify(draft) !== JSON.stringify(r)
  }, [draft, rubrics, selected])

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const res = await fetch('/api/settings/coaching-rubrics', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: draft.version,
          patch: {
            description: draft.description,
            company_context: draft.company_context,
            prompt_template: draft.prompt_template,
            call_types: draft.call_types,
          },
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      toast(`Rubric ${draft.version} saved${draft.is_active ? ' — applies from the next analysis run' : ''}`, 'success')
      await load()
    } catch (e: any) {
      toast(e?.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  async function activate(version: string) {
    const ok = await confirmDialog({
      title: `Make ${version} the active rubric?`,
      message: 'Every call analysed from the next run onward will be scored with this rubric.',
      confirmLabel: 'Activate',
    })
    if (!ok) return
    const res = await fetch('/api/settings/coaching-rubrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'activate', version }),
    })
    const j = await res.json()
    if (!res.ok) return toast(j.error || 'Activate failed', 'error')
    toast(`${version} is now active`, 'success')
    load()
  }

  async function duplicate(version: string) {
    const newVersion = await promptDialog({
      title: `Duplicate ${version}`,
      label: 'Name for the new version (e.g. v5-my-change). It starts inactive.',
      placeholder: 'v5-…',
    })
    if (!newVersion || !newVersion.trim()) return
    const res = await fetch('/api/settings/coaching-rubrics', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'duplicate', version, new_version: newVersion.trim() }),
    })
    const j = await res.json()
    if (!res.ok) return toast(j.error || 'Duplicate failed', 'error')
    toast(`Created ${newVersion.trim()}`, 'success')
    await load()
    setSelected(newVersion.trim())
  }

  // ── Call-type / dimension draft mutators ─────────────────────────────
  const patchType = (ti: number, p: Partial<CallType>) =>
    setDraft(d => { if (!d?.call_types) return d; const ct = [...d.call_types]; ct[ti] = { ...ct[ti], ...p }; return { ...d, call_types: ct } })
  const patchDim = (ti: number, di: number, p: Partial<Dimension>) =>
    setDraft(d => {
      if (!d?.call_types) return d
      const ct = [...d.call_types]
      const dims = [...(ct[ti].dimensions || [])]
      dims[di] = { ...dims[di], ...p }
      ct[ti] = { ...ct[ti], dimensions: dims }
      return { ...d, call_types: ct }
    })

  if (loading) return <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic', padding: 20 }}>Loading rubrics…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Version picker */}
      <Card title="Rubric versions" hint="One rubric is active at a time — the analyser reads it on every run, so changes apply within minutes, no deploy needed.">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' }}>
          {rubrics.map(r => (
            <div key={r.version}
              onClick={() => setSelected(r.version)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${r.version === selected ? T.accent : T.border}`,
                background: r.version === selected ? `rgba(var(--t-ink),0.04)` : 'transparent',
              }}>
              <div style={{ fontFamily: 'monospace', fontSize: 12, color: T.text, minWidth: 150 }}>{r.version}</div>
              {r.is_active && <StatusPill label="Active" color={T.green} />}
              {!!r.call_types?.length && <StatusPill label={`${r.call_types.length} call types`} color={T.purple} />}
              <div style={{ fontSize: 11, color: T.text3, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description || '—'}</div>
              <div style={{ display: 'flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                {!r.is_active && <button style={miniBtn(T.green)} onClick={() => activate(r.version)}>Activate</button>}
                <button style={miniBtn(T.text3)} onClick={() => duplicate(r.version)}>Duplicate</button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {draft && (
        <>
          {draft.is_active && (
            <div style={{ fontSize: 12, color: T.amber, border: `1px solid ${T.amber}`, borderRadius: 6, padding: '8px 12px' }}>
              ⚠ This is the LIVE rubric — saved changes are used for every call analysed from the next run.
            </div>
          )}

          <Card title={`Edit ${draft.version}`}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 0' }}>
              <div>
                <div style={lbl}>Description</div>
                <input style={{ ...inp, width: '100%' }} value={draft.description || ''}
                  onChange={e => setDraft({ ...draft, description: e.target.value })} />
              </div>
              <div>
                <div style={lbl}>Company context (business knowledge the coach scores against)</div>
                <textarea style={{ ...ta, minHeight: 180 }} value={draft.company_context || ''}
                  onChange={e => setDraft({ ...draft, company_context: e.target.value })} />
              </div>
              <div>
                <button style={miniBtn(T.text3)} onClick={() => setShowPrompt(s => !s)}>
                  {showPrompt ? '▾ Hide' : '▸ Show'} advanced: full prompt template
                </button>
                {showPrompt && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, color: T.text3, marginBottom: 6 }}>
                      Placeholders filled at runtime: {'{company_context} {direction} {agent_name} {customer_number} {duration} {roster} {call_types} {transcript}'}
                    </div>
                    <textarea style={{ ...ta, minHeight: 320, fontFamily: 'monospace', fontSize: 11 }} value={draft.prompt_template}
                      onChange={e => setDraft({ ...draft, prompt_template: e.target.value })} />
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Call types */}
          {(draft.call_types || []).map((t, ti) => {
            const weightSum = (t.dimensions || []).reduce((s, d) => s + (Number(d.weight) || 0), 0)
            const weightOk = Math.abs(weightSum - 10) < 0.001
            return (
              <Card key={t.id} title={`Call type: ${t.label}`} hint={t.scoreable ? `Dimension weights total ${weightSum} ${weightOk ? '✓ (score is /100)' : `— should total 10 (max score is currently /${Math.round(weightSum * 10)})`}` : 'Not scored — classified only'}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '6px 0' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 10 }}>
                    <div>
                      <div style={lbl}>Label</div>
                      <input style={{ ...inp, width: '100%' }} value={t.label} onChange={e => patchType(ti, { label: e.target.value })} />
                    </div>
                    <div>
                      <div style={lbl}>Scored?</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.text2, paddingTop: 6 }}>
                        <input type="checkbox" checked={t.scoreable} onChange={e => patchType(ti, { scoreable: e.target.checked })} />
                        {t.scoreable ? 'Scored' : 'Classified only'}
                      </label>
                    </div>
                  </div>
                  <div>
                    <div style={lbl}>When to classify a call as this type (shown to the model)</div>
                    <textarea style={{ ...ta, minHeight: 70 }} value={t.description} onChange={e => patchType(ti, { description: e.target.value })} />
                  </div>

                  {t.scoreable && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {(t.dimensions || []).map((d, di) => (
                        <div key={di} style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 90px 80px', gap: 8, alignItems: 'end' }}>
                            <div>
                              <div style={lbl}>ID (snake_case)</div>
                              <input style={{ ...inp, width: '100%', fontFamily: 'monospace', fontSize: 11 }} value={d.id}
                                onChange={e => patchDim(ti, di, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
                            </div>
                            <div>
                              <div style={lbl}>Label</div>
                              <input style={{ ...inp, width: '100%' }} value={d.label} onChange={e => patchDim(ti, di, { label: e.target.value })} />
                            </div>
                            <div>
                              <div style={lbl}>Weight</div>
                              <input style={{ ...inp, width: '100%' }} type="number" step="0.5" min="0.5" value={d.weight}
                                onChange={e => patchDim(ti, di, { weight: Number(e.target.value) })} />
                            </div>
                            <button style={{ ...miniBtn(T.red), height: 30 }} onClick={async () => {
                              const ok = await confirmDialog({ title: `Remove dimension "${d.label}"?`, confirmLabel: 'Remove' })
                              if (ok) patchType(ti, { dimensions: (t.dimensions || []).filter((_, i) => i !== di) })
                            }}>Remove</button>
                          </div>
                          <div>
                            <div style={lbl}>What the coach looks for</div>
                            <textarea style={{ ...ta, minHeight: 46 }} value={d.description} onChange={e => patchDim(ti, di, { description: e.target.value })} />
                          </div>
                          <div>
                            <div style={lbl}>Score anchors (10/7/5/3/0 — optional but keeps scoring consistent)</div>
                            <textarea style={{ ...ta, minHeight: 46 }} value={d.anchors || ''} onChange={e => patchDim(ti, di, { anchors: e.target.value })} />
                          </div>
                        </div>
                      ))}
                      <button style={miniBtn(T.accent)} onClick={() => patchType(ti, {
                        dimensions: [...(t.dimensions || []), { id: 'new_dimension', label: 'New dimension', weight: 1, description: '' }],
                      })}>+ Add dimension</button>
                    </div>
                  )}
                </div>
              </Card>
            )
          })}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button style={{ ...pbtn(T.green), opacity: dirty && !saving ? 1 : 0.5 }} disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : `Save ${draft.version}`}
            </button>
            {dirty && <span style={{ fontSize: 11, color: T.amber }}>Unsaved changes</span>}
          </div>
        </>
      )}

      {/* Advisor roster */}
      <Card title="Advisor roster" hint="Maps names heard on calls to Slack identities for attribution — extensions are shared desks, so the transcript introduction wins.">
        <RosterEditor roster={roster} onChanged={load} />
      </Card>
    </div>
  )
}

// ── Roster editor ────────────────────────────────────────────────────────

function RosterEditor({ roster, onChanged }: { roster: RosterRow[]; onChanged: () => void }) {
  const toast = useToast()
  const confirmDialog = useConfirm()
  const [rows, setRows] = useState<RosterRow[]>(roster)
  useEffect(() => { setRows(roster) }, [roster])

  const patch = (i: number, p: Partial<RosterRow>) =>
    setRows(rs => { const c = [...rs]; c[i] = { ...c[i], ...p }; return c })

  async function saveRow(row: RosterRow) {
    const res = await fetch('/api/settings/coaching-roster', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, patch: { name: row.name, aliases: row.aliases, slack_user_id: row.slack_user_id, extensions: row.extensions, active: row.active } }),
    })
    const j = await res.json()
    if (!res.ok) return toast(j.error || 'Save failed', 'error')
    toast(`${row.name} saved`, 'success')
    onChanged()
  }

  async function deleteRow(row: RosterRow) {
    const ok = await confirmDialog({ title: `Remove ${row.name} from the roster?`, message: 'Their calls stop being auto-attributed from transcripts.', confirmLabel: 'Remove', danger: true })
    if (!ok) return
    const res = await fetch('/api/settings/coaching-roster', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }),
    })
    const j = await res.json()
    if (!res.ok) return toast(j.error || 'Delete failed', 'error')
    onChanged()
  }

  async function addRow() {
    const res = await fetch('/api/settings/coaching-roster', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New advisor', aliases: [], extensions: [] }),
    })
    const j = await res.json()
    if (!res.ok) return toast(j.error || 'Add failed', 'error')
    onChanged()
  }

  const csv = (a: string[]) => (a || []).join(', ')
  const parse = (s: string) => s.split(/[,;]+/).map(x => x.trim()).filter(Boolean)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 110px 60px 120px', gap: 8, fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        <div>Name</div><div>Aliases (comma-sep)</div><div>Slack user ID</div><div>Extensions</div><div>Active</div><div />
      </div>
      {rows.map((r, i) => (
        <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 140px 110px 60px 120px', gap: 8, alignItems: 'center' }}>
          <input style={inp} value={r.name} onChange={e => patch(i, { name: e.target.value })} />
          <input style={inp} value={csv(r.aliases)} onChange={e => patch(i, { aliases: parse(e.target.value) })} />
          <input style={{ ...inp, fontFamily: 'monospace', fontSize: 11 }} value={r.slack_user_id || ''} onChange={e => patch(i, { slack_user_id: e.target.value })} />
          <input style={inp} value={csv(r.extensions)} onChange={e => patch(i, { extensions: parse(e.target.value) })} />
          <input type="checkbox" checked={r.active} onChange={e => patch(i, { active: e.target.checked })} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={miniBtn(T.green)} onClick={() => saveRow(r)}>Save</button>
            <button style={miniBtn(T.red)} onClick={() => deleteRow(r)}>✕</button>
          </div>
        </div>
      ))}
      <div><button style={miniBtn(T.accent)} onClick={addRow}>+ Add advisor</button></div>
    </div>
  )
}

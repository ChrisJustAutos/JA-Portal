// components/b2b/EmailTemplatesManager.tsx
// Editor for the B2B transactional email templates (supplier / distributor /
// internal). Loads from /api/b2b/admin/email-templates; per template: on/off
// toggle, subject, body (with {{placeholders}}), Save (PUT) + Reset (DELETE).

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'
import { useConfirm } from '../ui/Feedback'

interface Tpl {
  key: string; label: string; direction: string; description: string
  enabled: boolean; subject: string; body: string; isOverridden: boolean
  variables: { token: string; desc: string }[]
}

export default function EmailTemplatesManager() {
  const confirmDialog = useConfirm()
  const [templates, setTemplates] = useState<Tpl[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, { enabled: boolean; subject: string; body: string }>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [flash, setFlash] = useState('')

  async function load() {
    setLoading(true)
    const r = await fetch('/api/b2b/admin/email-templates')
    if (r.ok) {
      const d = await r.json()
      setTemplates(d.templates || [])
      const e: Record<string, any> = {}
      for (const t of d.templates || []) e[t.key] = { enabled: t.enabled, subject: t.subject, body: t.body }
      setEdits(e)
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function setField(key: string, field: 'enabled' | 'subject' | 'body', value: any) {
    setEdits(p => ({ ...p, [key]: { ...p[key], [field]: value } }))
  }
  async function save(key: string) {
    setSavingKey(key); setFlash('')
    const e = edits[key]
    const r = await fetch('/api/b2b/admin/email-templates', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, ...e }) })
    setSavingKey(null)
    if (r.ok) { setFlash(`Saved ${key}`); setTimeout(() => setFlash(''), 2000); load() }
    else { const d = await r.json().catch(() => ({})); setFlash(d.error || 'Save failed'); setTimeout(() => setFlash(''), 3500) }
  }
  async function reset(key: string) {
    if (!(await confirmDialog({ title: 'Reset this email to the built-in default?', message: 'Your custom subject/body will be lost.', danger: true }))) return
    setSavingKey(key)
    const r = await fetch(`/api/b2b/admin/email-templates?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
    setSavingKey(null)
    if (r.ok) { setFlash(`Reset ${key}`); setTimeout(() => setFlash(''), 2000); load() }
  }

  if (loading) return <SkeletonRows rows={8} />

  const groups = ['Supplier', 'Distributor', 'Internal']
  const inp: React.CSSProperties = { width: '100%', padding: '8px 11px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {flash && <div style={{ fontSize: 12, color: flash.startsWith('Save') || flash.startsWith('Reset') ? T.green : T.amber }}>{flash}</div>}
      {groups.map(group => {
        const inGroup = templates.filter(t => t.direction === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group}>
            <div style={{ fontSize: 11, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>{group} emails</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {inGroup.map(t => {
                const e = edits[t.key] || { enabled: t.enabled, subject: t.subject, body: t.body }
                const dirty = e.enabled !== t.enabled || e.subject !== t.subject || e.body !== t.body
                return (
                  <div key={t.key} style={{ background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, opacity: e.enabled ? 1 : 0.7 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{t.label}{t.isOverridden && <span style={{ fontSize: 10, color: T.amber, marginLeft: 8 }}>customised</span>}</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={e.enabled} onChange={ev => setField(t.key, 'enabled', ev.target.checked)} /> Enabled
                      </label>
                    </div>
                    <div style={{ fontSize: 11, color: T.text3, marginBottom: 12 }}>{t.description}</div>

                    <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Subject</div>
                    <input style={{ ...inp, marginBottom: 10 }} value={e.subject} onChange={ev => setField(t.key, 'subject', ev.target.value)} />

                    <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Message body</div>
                    <textarea style={{ ...inp, minHeight: 150, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} value={e.body} onChange={ev => setField(t.key, 'body', ev.target.value)} />

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
                      {t.variables.map(varr => (
                        <span key={varr.token} title={varr.desc} style={{ fontSize: 10, fontFamily: 'monospace', background: T.bg4, border: `1px solid ${T.border}`, borderRadius: 5, padding: '2px 7px', color: T.text2 }}>{`{{${varr.token}}}`}</span>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => save(t.key)} disabled={!dirty || savingKey === t.key}
                        style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: dirty ? T.blue : T.bg4, color: dirty ? '#fff' : T.text3, fontSize: 12, fontWeight: 600, cursor: dirty ? 'pointer' : 'default', fontFamily: 'inherit' }}>
                        {savingKey === t.key ? 'Saving…' : 'Save'}
                      </button>
                      {t.isOverridden && (
                        <button onClick={() => reset(t.key)} disabled={savingKey === t.key}
                          style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                          Reset to default
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 11, color: T.text3, lineHeight: 1.6 }}>
        Use the <code style={{ fontFamily: 'monospace' }}>{'{{tokens}}'}</code> above to drop in order data. Block tokens (line tables, addresses, buttons) insert formatted HTML; the rest are plain values. Disabling an email stops it sending — the underlying action (PO, freight, payment) still runs. Recipients: supplier = MYOB card; admin = the field above; distributor = their contact emails on the distributor page.
      </div>
    </div>
  )
}

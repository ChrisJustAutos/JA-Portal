// components/b2b/EmailTemplatesManager.tsx
// Editor for the B2B transactional email templates (supplier / distributor /
// internal). Loads from /api/b2b/admin/email-templates; per template: on/off
// toggle, subject, body (with {{placeholders}}), Save (PUT) + Reset (DELETE).
// Restyled onto the shared Alloy kit (components/b2b/ui) 2026-08-12.

import { useEffect, useState } from 'react'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../ui'
import { useConfirm } from '../ui/Feedback'
import { A, Btn, SectionLabel, inputStyle, RADIUS } from './ui'

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
  // Editor-density input — kit look at 13px (dense staff editor, floor is 12).
  const inp: React.CSSProperties = { ...inputStyle(), padding: '9px 12px', fontSize: 13, minHeight: 38 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {flash && <div style={{ fontSize: 12.5, color: flash.startsWith('Save') || flash.startsWith('Reset') ? A.good : A.warn }}>{flash}</div>}
      {groups.map(group => {
        const inGroup = templates.filter(t => t.direction === group)
        if (inGroup.length === 0) return null
        return (
          <div key={group}>
            <SectionLabel>{group} emails</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {inGroup.map(t => {
                const e = edits[t.key] || { enabled: t.enabled, subject: t.subject, body: t.body }
                const dirty = e.enabled !== t.enabled || e.subject !== t.subject || e.body !== t.body
                return (
                  <div key={t.key} style={{ background: T.bg3, borderRadius: RADIUS.md, padding: 16, opacity: e.enabled ? 1 : 0.7 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{t.label}{t.isOverridden && <span style={{ fontSize: 12, color: A.warn, marginLeft: 8 }}>customised</span>}</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: T.text2, cursor: 'pointer' }}>
                        <input type="checkbox" checked={e.enabled} onChange={ev => setField(t.key, 'enabled', ev.target.checked)} /> Enabled
                      </label>
                    </div>
                    <div style={{ fontSize: 12.5, color: T.text3, marginBottom: 12 }}>{t.description}</div>

                    <div style={{ fontSize: 12, color: T.text2, fontWeight: 650, marginBottom: 5 }}>Subject</div>
                    <input style={{ ...inp, marginBottom: 10 }} value={e.subject} onChange={ev => setField(t.key, 'subject', ev.target.value)} />

                    <div style={{ fontSize: 12, color: T.text2, fontWeight: 650, marginBottom: 5 }}>Message body</div>
                    <textarea style={{ ...inp, minHeight: 150, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} value={e.body} onChange={ev => setField(t.key, 'body', ev.target.value)} />

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '10px 0' }}>
                      {t.variables.map(varr => (
                        <span key={varr.token} title={varr.desc} style={{ fontSize: 12, fontFamily: 'monospace', background: T.bg4, borderRadius: RADIUS.pill, padding: '3px 10px', color: T.text2 }}>{`{{${varr.token}}}`}</span>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn size="sm" onClick={() => save(t.key)} disabled={!dirty || savingKey === t.key}>
                        {savingKey === t.key ? 'Saving…' : 'Save'}
                      </Btn>
                      {t.isOverridden && (
                        <Btn variant="ghost" size="sm" onClick={() => reset(t.key)} disabled={savingKey === t.key}>
                          Reset to default
                        </Btn>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <div style={{ fontSize: 12, color: T.text3, lineHeight: 1.6 }}>
        Use the <code style={{ fontFamily: 'monospace', fontSize: 12 }}>{'{{tokens}}'}</code> above to drop in order data. Block tokens (line tables, addresses, buttons) insert formatted HTML; the rest are plain values. Disabling an email stops it sending — the underlying action (PO, freight, payment) still runs. Recipients: supplier = MYOB card; admin = the field above; distributor = their contact emails on the distributor page.
      </div>
    </div>
  )
}

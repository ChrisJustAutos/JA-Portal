// components/crm/ComposeModal.tsx — quick one-off SMS/email to a contact from
// the CRM drawers, via /api/crm/send (logs to the contact timeline).

import { useState } from 'react'
import { T } from './CrmShell'
import { Overlay, Field, input, primaryBtn, ghostBtn, closeBtn } from './ui'
import { useToast } from '../ui/Feedback'

const VARS = ['first_name', 'contact_name', 'vehicle', 'lead_title', 'value', 'company']

export default function ComposeModal({ contactId, leadId, channel, to, onClose, onSent }: {
  contactId: string
  leadId?: string | null
  channel: 'sms' | 'email'
  to: string
  onClose: () => void
  onSent: () => void
}) {
  const toast = useToast()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    if (!body.trim()) return
    setBusy(true)
    try {
      const r = await fetch('/api/crm/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, lead_id: leadId || undefined, channel, subject, body }),
      })
      const d = await r.json()
      if (r.ok) { toast(`${channel === 'sms' ? 'SMS' : 'Email'} sent to ${d.to}`, 'success'); onSent(); onClose() }
      else toast(d.error || 'Send failed', 'error')
    } catch (e: any) { toast(e?.message || 'Send failed', 'error') } finally { setBusy(false) }
  }

  return (
    <Overlay onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, flex: 1 }}>{channel === 'sms' ? '💬 Send SMS' : '✉️ Send email'}</h2>
        <button onClick={onClose} style={closeBtn}>✕</button>
      </div>
      <div style={{ fontSize: 12, color: T.text2, marginBottom: 12 }}>To: <span style={{ fontFamily: 'monospace' }}>{to}</span></div>
      {channel === 'email' && (
        <Field label="Subject"><input value={subject} onChange={e => setSubject(e.target.value)} style={input} autoFocus /></Field>
      )}
      <Field label={channel === 'sms' ? `Message · ${body.length} chars` : 'Body'}>
        <textarea value={body} onChange={e => setBody(e.target.value)} rows={channel === 'sms' ? 4 : 8} autoFocus={channel === 'sms'}
          style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} />
      </Field>
      <div style={{ fontSize: 10, color: T.text3, marginBottom: 12 }}>
        Placeholders: {VARS.map(v => <code key={v} style={{ background: T.bg3, padding: '1px 5px', borderRadius: 4, marginRight: 4, fontSize: 10 }}>{`{{${v}}}`}</code>)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onClose} style={ghostBtn}>Cancel</button>
        <button onClick={send} disabled={busy || !body.trim()} style={primaryBtn}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </Overlay>
  )
}

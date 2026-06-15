// components/workshop/SendEmailModal.tsx
// Editable preview before emailing a workshop document (quote / job card /
// invoice / PO). Loads the default recipient, subject and message, lets the
// user edit them, and offers optional attachments — the booking's own files and
// any PDFs attached to the job types applied to this job/quote — before sending.

import { useEffect, useState } from 'react'
import { T } from '../ui'
import { useToast } from '../ui/Feedback'

type DocType = 'quote' | 'jobcard' | 'invoice' | 'po'
interface Candidate { id: string; file_name: string; mime_type: string | null; size_bytes: number | null; source: 'job' | 'jobtype' }

const lbl: React.CSSProperties = { display: 'block', fontSize: 11, color: T.text3, fontWeight: 600, marginBottom: 5 }
const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }

export default function SendEmailModal({ type, id, onClose, onSent }: { type: DocType; id: string; onClose: () => void; onSent?: (to: string) => void }) {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [docName, setDocName] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(`/api/workshop/document?meta=1&type=${type}&id=${encodeURIComponent(id)}`)
        const d = await r.json()
        if (!alive) return
        if (!r.ok) { toast(d.error || 'Could not load', 'error'); onClose(); return }
        setTo(d.to || ''); setSubject(d.subject || ''); setMessage(d.message || '')
        setDocName(d.doc?.filename || 'document.pdf')
        setCandidates(d.attachments || [])
      } finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [type, id])  // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(fid: string) { setPicked(p => { const n = new Set(p); n.has(fid) ? n.delete(fid) : n.add(fid); return n }) }

  async function send() {
    if (!to.trim()) { toast('Add a recipient email', 'error'); return }
    setSending(true)
    try {
      const r = await fetch('/api/workshop/document', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id, to: to.trim(), subject, message, file_ids: Array.from(picked) }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) { toast(d.message || d.error || 'Send failed', 'error'); return }
      toast(`Emailed to ${d.to} ✓`, 'success')
      onSent?.(d.to); onClose()
    } finally { setSending(false) }
  }

  const jobFiles = candidates.filter(c => c.source === 'job')
  const jtFiles = candidates.filter(c => c.source === 'jobtype')
  const Row = (c: Candidate) => (
    <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12, color: T.text, cursor: 'pointer' }}>
      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} style={{ cursor: 'pointer' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{/pdf/i.test(c.mime_type || '') ? '📄' : '📎'} {c.file_name}</span>
    </label>
  )

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 540, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, color: T.text }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>Email {type === 'jobcard' ? 'job card' : type} to customer</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        {loading ? <div style={{ padding: 24, color: T.text3, fontSize: 12 }}>Loading preview…</div> : (
          <>
            <label style={lbl}>To</label>
            <input value={to} onChange={e => setTo(e.target.value)} style={inp} placeholder="customer@email.com" />
            <label style={{ ...lbl, marginTop: 14 }}>Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} style={inp} />
            <label style={{ ...lbl, marginTop: 14 }}>Message</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} style={{ ...inp, resize: 'vertical' }} />
            <div style={{ fontSize: 10, color: T.text3, marginTop: 4 }}>The total and a friendly greeting/sign-off are added automatically.</div>

            <label style={{ ...lbl, marginTop: 16 }}>Attachments</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12, color: T.text2 }}>
              <input type="checkbox" checked readOnly disabled style={{ cursor: 'not-allowed' }} />
              <span>📄 {docName} <span style={{ color: T.text3 }}>(the {type === 'jobcard' ? 'job card' : type})</span></span>
            </div>
            {jobFiles.length > 0 && <>
              <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 8 }}>Job files</div>
              {jobFiles.map(Row)}
            </>}
            {jtFiles.length > 0 && <>
              <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 8 }}>Job-type documents</div>
              {jtFiles.map(Row)}
            </>}
            {candidates.length === 0 && <div style={{ fontSize: 11, color: T.text3, padding: '4px 0' }}>No optional attachments for this {type === 'jobcard' ? 'job' : type}.</div>}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 20 }}>
              <button onClick={() => window.open(`/api/workshop/document?type=${type}&id=${encodeURIComponent(id)}`, '_blank')} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>👁 Preview PDF</button>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: T.text2, border: `1px solid ${T.border2}` }}>Cancel</button>
                <button onClick={send} disabled={sending} style={{ padding: '8px 18px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: T.accent, color: '#fff', border: 'none' }}>{sending ? 'Sending…' : '✉ Send'}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

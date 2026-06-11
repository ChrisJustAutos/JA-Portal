// components/crm/CallButton.tsx
// Click-to-dial: queues an originate request (/api/calls/originate) — the PBX
// rings YOUR handset first, then dials the customer and bridges. Inline state
// machine polls the outcome. Hidden unless NEXT_PUBLIC_CLICK_TO_DIAL=1 (the
// on-PBX worker must understand mode='originate' before the button goes live).

import { useEffect, useRef, useState } from 'react'
import { T } from './CrmShell'
import { useToast } from '../ui/Feedback'

type DialState = 'idle' | 'queueing' | 'ringing' | 'connected' | 'failed'

export const CLICK_TO_DIAL_ENABLED = process.env.NEXT_PUBLIC_CLICK_TO_DIAL === '1'

export default function CallButton({ contactId, leadId, number, label }: {
  contactId?: string | null
  leadId?: string | null
  number?: string | null
  label?: string
}) {
  const toast = useToast()
  const [state, setState] = useState<DialState>('idle')
  const [detail, setDetail] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  if (!CLICK_TO_DIAL_ENABLED) return null
  if (!contactId && !leadId && !number) return null

  async function dial() {
    if (state === 'queueing' || state === 'ringing') return
    setState('queueing'); setDetail('')
    try {
      const r = await fetch('/api/calls/originate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId || undefined, lead_id: leadId || undefined, to: number || undefined }),
      })
      const d = await r.json()
      if (!r.ok) { setState('failed'); setDetail(d.message || d.error || 'Failed'); toast(d.message || d.error || 'Call failed', 'error'); return }
      setState('ringing'); setDetail(`Ringing your handset (ext ${d.extension})…`)
      const id = d.request_id
      pollRef.current = setInterval(async () => {
        try {
          const pr = await fetch(`/api/calls/originate?id=${encodeURIComponent(id)}`)
          const pd = await pr.json()
          if (!pr.ok) return
          if (pd.status === 'claimed') setDetail('Dialling the customer…')
          else if (pd.status === 'connected') {
            setState('connected'); setDetail('Connected ✓')
            if (pollRef.current) clearInterval(pollRef.current)
            setTimeout(() => setState('idle'), 6000)
          } else if (pd.status === 'failed' || pd.status === 'expired') {
            setState('failed')
            setDetail(pd.status === 'expired' ? 'PBX agent offline — request expired' : (pd.error || 'Call failed'))
            if (pollRef.current) clearInterval(pollRef.current)
          }
        } catch { /* keep polling */ }
      }, 1500)
      // Hard stop after 90s regardless.
      setTimeout(() => { if (pollRef.current) clearInterval(pollRef.current) }, 90_000)
    } catch (e: any) { setState('failed'); setDetail(e?.message || 'Network error') }
  }

  const busy = state === 'queueing' || state === 'ringing'
  const color = state === 'connected' ? T.green : state === 'failed' ? T.red : T.teal
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button onClick={dial} disabled={busy} title="Call — rings your handset first, then dials the customer"
        style={{
          padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          background: `${color}1e`, color, border: `1px solid ${color}55`, cursor: busy ? 'default' : 'pointer',
        }}>
        {busy ? '📞 Calling…' : `📞 ${label || 'Call'}`}
      </button>
      {detail && <span style={{ fontSize: 11, color: state === 'failed' ? T.red : T.text2 }}>{detail}</span>}
    </span>
  )
}

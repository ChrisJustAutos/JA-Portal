// pages/workshop/comms.tsx
// Communications history — every SMS + email the workshop has sent/queued
// (workshop_reminders): booking reminders, follow-ups, manual texts, emailed
// quotes/invoices/job cards, etc. Filter by channel + status, search.

import { useCallback, useEffect, useState } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import WorkshopTabs from '../../components/WorkshopTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T, Chip } from '../../components/ui'

const TYPE_LABEL: Record<string, string> = {
  document: 'Document', manual: 'Manual', booking: 'Booking reminder', booking_confirmation: 'Booking confirmation',
  ready: 'Ready for collection', followup: 'Follow-up', follow_up: 'Follow-up', review_request: 'Review request',
  payment_receipt: 'Payment receipt', quote_follow_up: 'Quote follow-up', service_due: 'Service due', rego_due: 'Rego due',
}
const STATUS_COLOR: Record<string, string> = { sent: '#3fb950', failed: '#f04e4e', pending: '#d8a23a', cancelled: '#6b7280' }

function bneDateTime(iso: string | null): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('en-AU', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Australia/Brisbane' }) } catch { return iso }
}

export default function CommsPage({ user }: { user: PortalUserSSR }) {
  const [comms, setComms] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [channel, setChannel] = useState<'' | 'sms' | 'email'>('')
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<any | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ limit: '300' })
      if (channel) p.set('channel', channel)
      if (status) p.set('status', status)
      if (q.trim()) p.set('q', q.trim())
      const r = await fetch(`/api/workshop/reminders?${p.toString()}`)
      const d = await r.json()
      if (r.ok) setComms(d.comms || [])
      setLastRefresh(new Date())
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [channel, status, q])
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t) }, [load])

  const GRID = '140px 70px 1fr 150px 1fr 90px'

  return (
    <>
      <Head><title>Comms — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <PortalTopBar activeId="diary" lastRefresh={lastRefresh} onRefresh={load} refreshing={loading}
          currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <WorkshopTabs active="comms" role={user.role} />

        <div style={{ background: T.bg2, borderBottom: `1px solid ${T.border}`, padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Communications</span>
          <span style={{ fontSize: 11, color: T.text3 }}>· {comms.length}</span>
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            <Chip label="All" active={channel === ''} onClick={() => setChannel('')} />
            <Chip label="SMS" active={channel === 'sms'} onClick={() => setChannel('sms')} />
            <Chip label="Email" active={channel === 'email'} onClick={() => setChannel('email')} />
          </div>
          <div style={{ width: 1, height: 18, background: T.border }} />
          <div style={{ display: 'flex', gap: 4 }}>
            <Chip label="Any" active={status === ''} onClick={() => setStatus('')} />
            <Chip label="Sent" active={status === 'sent'} onClick={() => setStatus('sent')} c={T.green} />
            <Chip label="Failed" active={status === 'failed'} onClick={() => setStatus('failed')} c={T.red} />
            <Chip label="Pending" active={status === 'pending'} onClick={() => setStatus('pending')} c={T.amber} />
          </div>
          <div style={{ flex: 1 }} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search message, number, email, customer…" style={{ padding: '5px 10px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: 'inherit', width: 280 }} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '9px 16px', background: T.bg3, borderBottom: `1px solid ${T.border}`, fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <div>When</div><div>Channel</div><div>To / Customer</div><div>Type</div><div>Message</div><div style={{ textAlign: 'right' }}>Status</div>
            </div>
            {!loading && comms.length === 0 && <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>No communications{q || channel || status ? ' match these filters' : ' yet'}.</div>}
            {comms.map(c => {
              const cust = Array.isArray(c.customer) ? c.customer[0] : c.customer
              const to = c.channel === 'email' ? c.to_email : c.to_number
              return (
                <div key={c.id} onClick={() => setOpen(c)} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '10px 16px', borderTop: `1px solid ${T.border}`, alignItems: 'center', cursor: 'pointer', fontSize: 12.5 }}>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: T.text2 }}>{bneDateTime(c.sent_at || c.send_at || c.created_at)}</div>
                  <div><span style={{ fontSize: 10, fontWeight: 700, color: c.channel === 'email' ? T.blue : T.teal }}>{c.channel === 'email' ? '✉ Email' : '💬 SMS'}</span></div>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cust?.name || <span style={{ fontFamily: 'monospace', color: T.text2 }}>{to || '—'}</span>}{cust?.name && to ? <span style={{ color: T.text3, fontSize: 11 }}> · {to}</span> : null}</div>
                  <div style={{ color: T.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{TYPE_LABEL[c.type] || c.type}</div>
                  <div style={{ color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject ? <span style={{ color: T.text }}>{c.subject} · </span> : null}{(c.body || '').replace(/\s+/g, ' ').slice(0, 80)}</div>
                  <div style={{ textAlign: 'right' }}><span style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLOR[c.status] || T.text3, textTransform: 'uppercase' }}>{c.status}</span></div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 130 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 560, maxWidth: '94vw', maxHeight: '88vh', overflow: 'auto', background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, color: T.text }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{open.channel === 'email' ? '✉ Email' : '💬 SMS'} · {TYPE_LABEL[open.type] || open.type}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[open.status] || T.text3, textTransform: 'uppercase' }}>{open.status}</span>
              <button onClick={() => setOpen(null)} style={{ background: 'transparent', border: 'none', color: T.text3, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 4 }}>To: <span style={{ color: T.text2, fontFamily: 'monospace' }}>{open.channel === 'email' ? open.to_email : open.to_number}</span></div>
            <div style={{ fontSize: 12, color: T.text3, marginBottom: 10 }}>Sent: {bneDateTime(open.sent_at || open.send_at || open.created_at)}</div>
            {open.subject && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{open.subject}</div>}
            <div style={{ fontSize: 13, color: T.text, whiteSpace: 'pre-wrap', lineHeight: 1.5, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>{open.body}</div>
            {open.error && <div style={{ marginTop: 10, fontSize: 12, color: T.red }}>Error: {open.error}</div>}
          </div>
        </div>
      )}
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:diary')
}

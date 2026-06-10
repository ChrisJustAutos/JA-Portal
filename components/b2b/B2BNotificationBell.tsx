// components/b2b/B2BNotificationBell.tsx
// Notification bell for the distributor portal header. Polls the unread count
// every 30s, loads the list on open, click-through to the order, mark/clear.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { useConfirm } from '../ui/Feedback'

const T = {
  bg2: '#131519', border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#aab0c0', text3: '#8d93a4', blue: '#4f8ef7', red: '#f04e4e',
}

interface Row { id: string; title: string; body: string | null; href: string | null; created_at: string; read_at: string | null }

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export default function B2BNotificationBell({ isMobile }: { isMobile?: boolean }) {
  const router = useRouter()
  const confirmDialog = useConfirm()
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)

  function loadCount() {
    fetch('/api/b2b/notifications', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) { setUnread(d.unread || 0); setRows(d.notifications || []) } }).catch(() => {})
  }
  useEffect(() => {
    loadCount()
    const i = setInterval(loadCount, 30000)
    return () => clearInterval(i)
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function patch(b: { id?: string; all?: boolean }) {
    return fetch('/api/b2b/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(loadCount).catch(() => {})
  }
  function remove(b: { id?: string; all?: boolean }) {
    setRows(rs => b.all ? [] : (rs || []).filter(r => r.id !== b.id))
    return fetch('/api/b2b/notifications', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(loadCount).catch(() => {})
  }
  function openRow(r: Row) {
    setOpen(false)
    if (!r.read_at) { setRows(rs => (rs || []).map(x => x.id === r.id ? { ...x, read_at: new Date().toISOString() } : x)); patch({ id: r.id }) }
    if (r.href) router.push(r.href)
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} aria-label="Notifications" title="Notifications"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 6, padding: isMobile ? '8px 10px' : '6px 9px', cursor: 'pointer', position: 'relative', minHeight: 36 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>
        </svg>
        {unread > 0 && (
          <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8, background: T.red, color: '#fff', fontSize: 9.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace' }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 901 }}/>
          <div style={isMobile ? {
            position: 'fixed', top: 64, left: 8, right: 8, zIndex: 902, maxHeight: '74vh', overflowY: 'auto',
            background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10, boxShadow: '0 14px 40px rgba(0,0,0,0.45)', padding: 6,
          } : {
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 902, width: 340, maxWidth: 'calc(100vw - 24px)', maxHeight: '74vh', overflowY: 'auto',
            background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10, boxShadow: '0 14px 40px rgba(0,0,0,0.45)', padding: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 8px', borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>Notifications</span>
              <span style={{ flex: 1 }}/>
              {unread > 0 && <button onClick={() => patch({ all: true })} style={{ background: 'none', border: 'none', color: T.blue, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>Mark all read</button>}
              {(rows?.length || 0) > 0 && <button onClick={async () => { if (await confirmDialog({ title: 'Clear all notifications?', danger: true })) remove({ all: true }) }} style={{ background: 'none', border: 'none', color: T.text3, fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginLeft: 12 }}>Clear all</button>}
            </div>
            {rows === null && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>Loading…</div>}
            {rows !== null && rows.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>No notifications yet.</div>}
            {(rows || []).map(r => {
              const u = !r.read_at
              return (
                <div key={r.id} onClick={() => openRow(r)} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 10px', borderRadius: 7, cursor: 'pointer', background: u ? 'rgba(79,142,247,0.07)' : 'none', marginBottom: 1 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: u ? 600 : 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                    {r.body && <span style={{ display: 'block', fontSize: 11.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{r.body}</span>}
                  </span>
                  <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>{ago(r.created_at)}</span>
                  {u && <span style={{ width: 7, height: 7, borderRadius: '50%', background: T.red, flexShrink: 0, marginTop: 6 }}/>}
                  <button onClick={(e) => { e.stopPropagation(); remove({ id: r.id }) }} title="Delete" style={{ background: 'none', border: 'none', color: T.text3, fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', marginTop: 1, flexShrink: 0 }}>×</button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

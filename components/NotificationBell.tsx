// components/NotificationBell.tsx
// Reusable notification bell + dropdown — used by the top bar (lib/PortalTopBar)
// and the home launcher header. The parent owns the single summary poll and
// passes { summary, refresh } so there's no double polling on a page.
//
// Dropdown: list (click → mark read + go to the module's page), per-row delete,
// mark all read, clear all, send test, and a notification-sound picker.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { AppIcon } from '../lib/AppIcons'
import { useIsMobile } from '../lib/useIsMobile'
import { timeAgo, NotificationRow, NotificationSummary } from '../lib/useNotifications'
import { NOTIFICATION_SOUNDS, getSound, setSound, playSound, primeAudio } from '../lib/notificationSounds'
import { enableNotifications, ensurePushSubscription } from '../lib/pushClient'

// Inlined at build time — tells us whether server push is configured in THIS build.
const VAPID_CONFIGURED = !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

const T = {
  bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', red: '#f04e4e',
}

interface AppLite { id: string; accent: string }

export default function NotificationBell({ apps, summary, refresh }: {
  apps: AppLite[]
  summary: NotificationSummary | null
  refresh: () => void
}) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [notifs, setNotifs] = useState<NotificationRow[] | null>(null)
  const [sound, setSoundState] = useState('chime')
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default')
  const [pushCount, setPushCount] = useState<number | null>(null)
  const [registering, setRegistering] = useState(false)
  const [regMsg, setRegMsg] = useState<string | null>(null)

  function loadPushCount() {
    fetch('/api/notifications/push-subscribe', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) setPushCount(d.count) }).catch(() => {})
  }
  async function registerDevice() {
    setRegistering(true); setRegMsg(null)
    try {
      await ensurePushSubscription()
      const d = await fetch('/api/notifications/push-subscribe', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).catch(() => null)
      const c = d?.count ?? 0
      setPushCount(c)
      setRegMsg(c > 0 ? '✓ Registered on this device' : 'Couldn’t register — fully close the app and reopen, then try again')
    } finally { setRegistering(false) }
  }

  useEffect(() => {
    setSoundState(getSound())
    if (typeof Notification === 'undefined') setPerm('unsupported')
    else setPerm(Notification.permission)
  }, [])
  // Re-check permission + registered-device count each time the dropdown opens.
  useEffect(() => {
    if (!open) return
    if (typeof Notification !== 'undefined') setPerm(Notification.permission)
    loadPushCount()
  }, [open])

  async function enable() {
    primeAudio()  // this click also unlocks sound
    const p = await enableNotifications()
    setPerm(p)
  }

  useEffect(() => {
    if (!open) return
    fetch('/api/notifications').then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setNotifs(d.notifications) }).catch(() => {})
  }, [open])

  // Esc closes the dropdown.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  function markRead(body: { id?: string; all?: boolean }) {
    return fetch('/api/notifications', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => refresh()).catch(() => {})
  }
  function deleteNotifs(body: { id?: string; all?: boolean }) {
    setNotifs(list => body.all ? [] : (list || []).filter(x => x.id !== body.id))
    return fetch('/api/notifications', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(() => refresh()).catch(() => {})
  }
  function openNotification(n: NotificationRow) {
    setOpen(false)
    if (!n.read_at) {
      setNotifs(list => (list || []).map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))
      markRead({ id: n.id })
    }
    if (n.href) router.push(n.href)   // → through to the module the notification is for
  }
  function chooseSound(id: string) {
    setSoundState(id); setSound(id); playSound(id)  // preview on change
  }

  const total = summary?.total || 0

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} aria-label="Notifications" title="Notifications"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 8, padding: '7px 9px', cursor: 'pointer', position: 'relative' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.7 21a2 2 0 0 1-3.4 0"/>
        </svg>
        {total > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5,
            minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
            background: T.red, color: '#fff', fontSize: 9.5, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace',
          }}>{total > 99 ? '99+' : total}</span>
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 901 }}/>
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: isMobile ? -60 : 0, zIndex: 902,
            width: isMobile ? 'calc(100vw - 24px)' : 360, maxWidth: 'calc(100vw - 24px)',
            maxHeight: '74vh', overflowY: 'auto',
            background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 10,
            boxShadow: '0 14px 40px rgba(0,0,0,0.45)', padding: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px 8px', borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>Notifications</span>
              <button
                onClick={() => fetch('/api/notifications/test', { method: 'POST', credentials: 'same-origin' }).then(() => setTimeout(refresh, 800)).catch(() => {})}
                title="Send yourself a test notification"
                style={{ background: 'none', border: 'none', color: T.text3, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', padding: 0, marginLeft: 10 }}>
                Send test
              </button>
              <span style={{ flex: 1 }}/>
              {total > 0 && (
                <button
                  onClick={() => { markRead({ all: true }); setNotifs(list => (list || []).map(x => ({ ...x, read_at: x.read_at || new Date().toISOString() }))) }}
                  style={{ background: 'none', border: 'none', color: T.blue, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', padding: 0 }}>
                  Mark all read
                </button>
              )}
              {(notifs?.length || 0) > 0 && (
                <button
                  onClick={() => { if (confirm('Delete all notifications?')) deleteNotifs({ all: true }) }}
                  style={{ background: 'none', border: 'none', color: T.text3, fontSize: 11.5, fontFamily: 'inherit', cursor: 'pointer', padding: 0, marginLeft: 12 }}>
                  Clear all
                </button>
              )}
            </div>

            {/* Permission banner — pop-ups need the browser's go-ahead */}
            {perm === 'default' && (
              <button onClick={enable}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'rgba(79,142,247,0.12)', border: `1px solid ${T.blue}55`, color: T.text, borderRadius: 8, padding: '9px 11px', margin: '2px 0 6px', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}>
                🔔 <span style={{ flex: 1 }}>Enable desktop notifications</span>
                <span style={{ color: T.blue, fontWeight: 600 }}>Turn on →</span>
              </button>
            )}
            {perm === 'denied' && (
              <div style={{ background: 'rgba(245,166,35,0.12)', border: `1px solid #f5a62355`, color: '#f5a623', borderRadius: 8, padding: '9px 11px', margin: '2px 0 6px', fontSize: 11.5, lineHeight: 1.4 }}>
                Notifications are blocked for this site. Turn them on in your browser’s site settings (the 🔒 icon in the address bar → Notifications → Allow), then reopen the app.
              </div>
            )}
            {perm === 'unsupported' && (
              <div style={{ background: 'rgba(245,166,35,0.12)', border: `1px solid #f5a62355`, color: '#f5a623', borderRadius: 8, padding: '9px 11px', margin: '2px 0 6px', fontSize: 11.5, lineHeight: 1.45 }}>
                Notifications aren’t available here. On iPhone: open the app from the <b>Home Screen icon</b> (not Safari) on <b>iOS 16.4+</b>. If you just updated, fully close the app (swipe it away) and reopen it.
              </div>
            )}
            {/* Permission granted but background push not yet registered on this device */}
            {perm === 'granted' && !VAPID_CONFIGURED && (
              <div style={{ background: 'rgba(245,166,35,0.12)', border: `1px solid #f5a62355`, color: '#f5a623', borderRadius: 8, padding: '9px 11px', margin: '2px 0 6px', fontSize: 11.5, lineHeight: 1.45 }}>
                On-screen pop-ups work, but <b>background push isn’t set up in this build</b> (server key missing). It’ll switch on after the next deploy with the VAPID keys.
              </div>
            )}
            {perm === 'granted' && VAPID_CONFIGURED && pushCount === 0 && (
              <button onClick={registerDevice} disabled={registering}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'rgba(79,142,247,0.12)', border: `1px solid ${T.blue}55`, color: T.text, borderRadius: 8, padding: '9px 11px', margin: '2px 0 6px', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer' }}>
                🔔 <span style={{ flex: 1 }}>This device isn’t registered for background push</span>
                <span style={{ color: T.blue, fontWeight: 600 }}>{registering ? '…' : 'Register →'}</span>
              </button>
            )}
            {regMsg && (
              <div style={{ fontSize: 11, color: regMsg.startsWith('✓') ? '#34c77b' : '#f5a623', padding: '0 11px 6px' }}>{regMsg}</div>
            )}

            {notifs === null && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>Loading…</div>}
            {notifs !== null && notifs.length === 0 && <div style={{ color: T.text3, fontSize: 12, padding: '14px 10px' }}>No notifications yet.</div>}
            {(notifs || []).map(n => {
              const app = apps.find(a => a.id === n.module)
              const unread = !n.read_at
              return (
                <div key={n.id} onClick={() => openNotification(n)} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%', textAlign: 'left',
                  background: unread ? 'rgba(79,142,247,0.07)' : 'none', borderRadius: 7,
                  padding: '8px 10px', cursor: 'pointer', fontFamily: 'inherit', marginBottom: 1, boxSizing: 'border-box',
                }}>
                  <span style={{
                    width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginTop: 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `${app?.accent || T.blue}1f`, color: app?.accent || T.blue,
                  }}>
                    <AppIcon name={n.module} size={15}/>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: unread ? 600 : 500, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title}</span>
                    {n.body && <span style={{ display: 'block', fontSize: 11.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>{n.body}</span>}
                  </span>
                  <span style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace', flexShrink: 0, marginTop: 2 }}>{timeAgo(n.created_at)}</span>
                  {unread && <span style={{ width: 7, height: 7, borderRadius: '50%', background: T.red, flexShrink: 0, marginTop: 6 }}/>}
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteNotifs({ id: n.id }) }}
                    title="Delete notification" aria-label="Delete notification"
                    style={{ background: 'none', border: 'none', color: T.text3, fontSize: 14, lineHeight: 1, cursor: 'pointer', padding: '2px 3px', marginTop: 1, flexShrink: 0, borderRadius: 4 }}
                    onMouseEnter={e => { e.currentTarget.style.color = T.red }}
                    onMouseLeave={e => { e.currentTarget.style.color = T.text3 }}
                  >×</button>
                </div>
              )
            })}

            {/* Sound picker */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: `1px solid ${T.border}`, marginTop: 4, padding: '8px 10px 4px' }}>
              <span style={{ fontSize: 11.5, color: T.text3 }}>🔔 Sound</span>
              <span style={{ flex: 1 }}/>
              <select value={sound} onChange={e => chooseSound(e.target.value)}
                style={{ background: T.bg3, border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 6, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', outline: 'none' }}>
                {NOTIFICATION_SOUNDS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <button onClick={() => playSound(sound)} title="Preview"
                style={{ background: 'none', border: `1px solid ${T.border2}`, color: T.text2, borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>▶</button>
            </div>
            {perm === 'granted' && VAPID_CONFIGURED && (pushCount || 0) > 0 && (
              <div style={{ fontSize: 10.5, color: T.text3, padding: '4px 10px 2px' }}>
                Background push: on · {pushCount} device{pushCount === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

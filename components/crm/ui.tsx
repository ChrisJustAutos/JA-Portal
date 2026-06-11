// components/crm/ui.tsx — small shared CRM UI atoms (drawer, fields, timeline).
import React from 'react'
import { T, fmtDateTime } from './CrmShell'

export const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: T.bg3, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
export const primaryBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, background: T.blue, color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
export const ghostBtn: React.CSSProperties = { padding: '7px 14px', borderRadius: 6, fontSize: 12, background: 'transparent', color: T.text2, border: `1px solid ${T.border2}`, cursor: 'pointer', fontFamily: 'inherit' }
export const closeBtn: React.CSSProperties = { background: 'none', border: 'none', color: T.text3, fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }

export function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(8,10,13,0.6)' }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 1001, width: 'min(480px, 100vw)',
        background: T.bg2, borderLeft: `1px solid ${T.border2}`, boxShadow: '-12px 0 40px rgba(0,0,0,0.4)',
        padding: 22, overflowY: 'auto', fontFamily: '"DM Sans", system-ui, sans-serif', color: T.text,
      }}>{children}</div>
    </>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

// Per-type accent so the timeline reads at a glance; call entries with a
// matched CDR link through to /calls.
const ACTIVITY_META: Record<string, { icon: string; color: string }> = {
  note: { icon: '📝', color: T.text3 },
  call: { icon: '📞', color: T.teal },
  email: { icon: '✉️', color: T.blue },
  sms: { icon: '💬', color: T.teal },
  stage_change: { icon: '➡️', color: T.amber },
  lead_created: { icon: '✨', color: T.green },
  contact_created: { icon: '👤', color: T.green },
  task: { icon: '✅', color: T.amber },
  workshop_handoff: { icon: '🔧', color: T.teal },
  website_lead: { icon: '🌐', color: T.blue },
  quote_status: { icon: '🧾', color: T.purple },
  booking_created: { icon: '📅', color: T.green },
  campaign_open: { icon: '👁', color: T.blue },
  campaign_click: { icon: '🔗', color: T.blue },
}

export function Timeline({ activities }: { activities: any[] }) {
  if (!activities.length) return <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic' }}>No activity yet.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {activities.map(a => {
        const meta = ACTIVITY_META[a.type] || { icon: '•', color: T.text3 }
        const callId = a.meta?.call_id
        return (
          <div key={a.id} style={{ display: 'flex', gap: 10 }}>
            <div title={String(a.type).replace(/_/g, ' ')} style={{ width: 18, textAlign: 'center', fontSize: 11, lineHeight: '18px', flexShrink: 0 }}>{meta.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: T.text, whiteSpace: 'pre-wrap' }}>
                <span style={{ color: meta.color, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 6 }}>{String(a.type).replace(/_/g, ' ')}</span>
                {a.body}
                {callId && (
                  <a href={`/calls?call=${callId}`} style={{ marginLeft: 6, fontSize: 10, color: T.blue, textDecoration: 'none' }}>
                    open call{a.meta?.has_recording ? ' ▶' : ''} →
                  </a>
                )}
              </div>
              <div style={{ fontSize: 10, color: T.text3, marginTop: 2 }}>{a.actor?.display_name ? `${a.actor.display_name} · ` : ''}{fmtDateTime(a.created_at)}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

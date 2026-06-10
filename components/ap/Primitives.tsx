// components/ap/Primitives.tsx
// Small presentational pieces shared across the AP detail page and its
// extracted sections (extracted from pages/ap/[id].tsx).
//
// TriagePill / StatusPill intentionally keep their own rendering (bordered
// `${c}15` badges) rather than wrapping the kit StatusPill, which has no
// border and a `${c}1e` background — adopting it would be a visual change.

import { T } from '../../lib/ui/theme'

export function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{minWidth:0}}>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4}}>{label}</div>
      {children}
    </div>
  )
}

export function Field({ label, value, mono, align, emphasised }: { label: string; value: string | number | null | undefined; mono?: boolean; align?: 'right'; emphasised?: boolean }) {
  return (
    <div>
      <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:2}}>{label}</div>
      <div style={{
        fontSize: emphasised ? 14 : 12,
        fontWeight: emphasised ? 600 : 400,
        color: value !== null && value !== undefined && value !== '' ? T.text : T.text3,
        fontFamily: mono ? 'monospace' : 'inherit',
        textAlign: align,
      }}>{value !== null && value !== undefined && value !== '' ? String(value) : '—'}</div>
    </div>
  )
}

export function TriagePill({ status }: { status: string }) {
  const conf = status === 'green'  ? { c: T.green,  label: '🟢 GREEN' } :
               status === 'yellow' ? { c: T.amber,  label: '🟡 YELLOW' } :
               status === 'red'    ? { c: T.red,    label: '🔴 RED' } :
                                     { c: T.text3,  label: 'PENDING' }
  return <span style={{display:'inline-block', padding:'3px 9px', borderRadius:3, background:`${conf.c}15`, border:`1px solid ${conf.c}40`, color:conf.c, fontSize:10, fontWeight:600, letterSpacing:'0.05em'}}>{conf.label}</span>
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    parsing: T.text3, pending_review: T.text2, ready: T.blue,
    posted: T.green, rejected: T.text3, escalated: T.amber, error: T.red,
  }
  const c = map[status] || T.text3
  return <span style={{display:'inline-block', padding:'3px 9px', borderRadius:3, background:`${c}15`, border:`1px solid ${c}40`, color:c, fontSize:10, fontWeight:500, textTransform:'uppercase', letterSpacing:'0.04em'}}>{status.replace('_',' ')}</span>
}

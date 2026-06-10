// components/crm/CrmShell.tsx
// Shared chrome for the CRM module: PortalTopBar + a sub-tab strip
// (Pipeline · Contacts · Tasks). Exports the design tokens + small shared
// types/helpers so the three CRM pages stay visually in lockstep.

import { ReactNode } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../lib/PortalTopBar'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

export type { PortalUserSSR }
export { T }

// Pipeline stage → accent colour (shared by board + drawers).
export const STAGE_COLOR: Record<string, string> = {
  new: T.blue, contacted: T.teal, quoted: T.purple, follow_up: T.amber,
  won: T.green, lost: T.red, on_hold: T.text3,
}
export const PRIORITY_COLOR: Record<string, string> = {
  low: T.text3, normal: T.blue, high: T.amber, urgent: T.red,
}

const TABS = [
  { id: 'pipeline', label: 'Pipeline', href: '/crm' },
  { id: 'contacts', label: 'Contacts', href: '/crm/contacts' },
  { id: 'tasks', label: 'Tasks', href: '/crm/tasks' },
  { id: 'automations', label: 'Automations', href: '/crm/automations' },
  { id: 'campaigns', label: 'Campaigns', href: '/crm/campaigns' },
]

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—'
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
export function fmtDate(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })
}
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return ''
  const d = new Date(s)
  return d.toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function CrmShell({
  user, active, children, title,
}: {
  user: PortalUserSSR
  active: 'pipeline' | 'contacts' | 'tasks' | 'automations' | 'campaigns'
  children: ReactNode
  title?: string
}) {
  const router = useRouter()
  return (
    <>
      <Head><title>{title ? `${title} · CRM` : 'CRM'} · JA Portal</title></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: T.bg, color: T.text, fontFamily: '"DM Sans", system-ui, sans-serif' }}>
        <PortalTopBar activeId="crm" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          {TABS.map(t => {
            const on = t.id === active
            return (
              <button key={t.id} onClick={() => router.push(t.href)} style={{
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                color: on ? T.text : T.text2, fontSize: 13, fontWeight: on ? 600 : 400,
                padding: '12px 14px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
              }}>{t.label}</button>
            )
          })}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>{children}</div>
      </div>
    </>
  )
}

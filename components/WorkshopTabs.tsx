// components/WorkshopTabs.tsx
// Top-level sub-tab strip for the Workshop module. Sits directly under the
// global top bar (all gated view:diary). Inventory has its own second-level
// strip (InventoryTabs) for Inventory/Purchase Orders/Stocktake/Stock Transfer.
//
// The tabs come from lib/workshop-sections.js, which is also what next.config.js
// reads to route the parked sections to the "not in use" notice — so the strip
// can never drift from what is actually reachable. MechanicDesk is the workshop
// system of record; only the sections marked active there appear here.

import { useRouter } from 'next/router'
import { Permission, UserRole, roleHasPermission } from '../lib/permissions'
import { T } from '../lib/ui/theme'
import WorkshopSearch from './WorkshopSearch'
import { activeWorkshopSections } from '../lib/workshop-sections'

const TABS: { id: string; label: string; href: string; perm?: Permission }[] =
  activeWorkshopSections().map((s: any) => ({ id: s.id, label: s.label, href: s.href, perm: s.perm as Permission | undefined }))


export type WorkshopTabId = 'diary' | 'jobs' | 'customers' | 'vehicles' | 'quotes' | 'orders' | 'invoices' | 'comms' | 'letters' | 'inventory' | 'reports'

export default function WorkshopTabs({ active, role }: { active: WorkshopTabId; role: UserRole }) {
  const router = useRouter()
  if (!roleHasPermission(role, 'view:diary')) return null
  return (
    <div className="workshop-tabs" style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0, overflowX: 'auto' }}>
      {/* Scrolls on overflow (narrow windows) but never shows a scrollbar —
          same pattern as B2BAdminTabs. */}
      <style>{`
        .workshop-tabs{ scrollbar-width:none; -ms-overflow-style:none; }
        .workshop-tabs::-webkit-scrollbar{ display:none; }
      `}</style>
      {TABS.filter(t => !t.perm || roleHasPermission(role, t.perm)).map(t => {
        const on = t.id === active
        return (
          <button key={t.id} onClick={() => router.push(t.href)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            color: on ? T.text : T.text2, fontSize: 13, fontWeight: on ? 600 : 400,
            padding: '12px 14px', borderBottom: `2px solid ${on ? T.accent : 'transparent'}`,
          }}>{t.label}</button>
        )
      })}
      <WorkshopSearch />
    </div>
  )
}

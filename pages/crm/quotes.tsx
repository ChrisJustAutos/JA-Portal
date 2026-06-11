// pages/crm/quotes.tsx — the workshop quote kanban inside the CRM shell.
// Same QuoteBoard component (workshop_quotes = single source of truth) with
// lead chips on, so sales see which pipeline lead each quote belongs to.
// Drag/convert need edit:bookings; view:crm alone gets a read-only board.

import { requirePageAuth } from '../../lib/authServer'
import { roleHasPermission } from '../../lib/permissions'
import CrmShell, { PortalUserSSR, T } from '../../components/crm/CrmShell'
import QuoteBoard from '../../components/workshop/QuoteBoard'

export default function CrmQuotesPage({ user }: { user: PortalUserSSR }) {
  const canEdit = roleHasPermission(user.role, 'edit:bookings')
  return (
    <CrmShell user={user} active="quotes" title="Quotes">
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexShrink: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Quotes</h1>
          {!canEdit && <span style={{ fontSize: 11, color: T.text3 }}>read-only — workshop edit access required to move or convert</span>}
        </div>
        <QuoteBoard canEdit={canEdit} showLeadChips />
      </div>
    </CrmShell>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}

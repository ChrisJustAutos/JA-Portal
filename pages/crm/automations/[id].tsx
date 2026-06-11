// pages/crm/automations/[id].tsx — full-screen flow canvas for one automation.
// React Flow is dynamically imported (ssr:false) so the library only loads on
// this page; the rest of the portal stays dependency-free.

import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { requirePageAuth } from '../../../lib/authServer'
import CrmShell, { PortalUserSSR, T } from '../../../components/crm/CrmShell'

const FlowEditor = dynamic(() => import('../../../components/crm/flow/FlowEditor'), {
  ssr: false,
  loading: () => <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Loading the canvas…</div>,
})

export default function AutomationCanvasPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  return (
    <CrmShell user={user} active="automations" title="Flow">
      <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {id && <FlowEditor automationId={id} />}
      </div>
    </CrmShell>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:crm')
}

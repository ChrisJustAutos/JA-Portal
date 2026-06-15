// pages/tasks/automations/[id].tsx — full-screen flow canvas for one task
// automation. React Flow is dynamically imported (ssr:false) so the library
// only loads on this page.
import dynamic from 'next/dynamic'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalTopBar from '../../../lib/PortalTopBar'
import { requirePageAuth } from '../../../lib/authServer'
import type { PortalUserSSR } from '../../../lib/authServer'
import { T } from '../../../components/ui'

const TaskFlowEditor = dynamic(() => import('../../../components/tasks/flow/TaskFlowEditor'), {
  ssr: false,
  loading: () => <div style={{ padding: 40, textAlign: 'center', color: T.text3, fontSize: 13 }}>Loading the canvas…</div>,
})

export default function TaskAutomationCanvas({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const id = typeof router.query.id === 'string' ? router.query.id : ''
  return (
    <>
      <Head><title>Task flow — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text, background: T.bg }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />
        <PortalTopBar activeId="tasks" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {id && <TaskFlowEditor automationId={id} />}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:tasks')
}

// pages/reports/mgmt-dashboard.tsx
// Reports â†’ Management Dashboard â€” portal-native rebuild of the JAWS weekly
// management Excel (KPI cards + 6 configurable charts from live MYOB data).
// Admin + manager only (Chris / Ryan / Jarred).

import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import MgmtDashboard from '../../components/reports/MgmtDashboard'
import { requirePageAuth, requireReportPageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

export default function MgmtDashboardPage({ user }: { user: PortalUserSSR }) {
  return (
    <>
      <Head><title>Management Dashboard â€” Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="mgmt-dashboard" role={user.role} reportTabs={user.visibleReportTabs} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <MgmtDashboard />
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const res: any = await requireReportPageAuth(context, 'mgmt-dashboard')
  // Management figures are admin + manager only â€” tighter than view:reports.
  if (res?.props?.user && !['admin', 'manager'].includes(res.props.user.role)) {
    return { redirect: { destination: '/?forbidden=1', permanent: false } }
  }
  return res
}

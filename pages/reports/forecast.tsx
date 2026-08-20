// pages/reports/forecast.tsx
// Reports → Forecast — portal rebuild of the Monday "Forecast Dashboard -
// Includes JAWS". Turnover by month, workshop (VPS) and wholesale (JAWS),
// this year against last. Admin + manager only, matching the Management
// Dashboard — these are whole-of-business turnover figures.

import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import ForecastDashboard from '../../components/reports/ForecastDashboard'
import { requireReportPageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

export default function ForecastPage({ user }: { user: PortalUserSSR }) {
  return (
    <>
      <Head><title>Forecast — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="forecast" role={user.role} reportTabs={user.visibleReportTabs} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <ForecastDashboard />
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  const res: any = await requireReportPageAuth(context, 'forecast')
  // Turnover for the whole group — admin + manager only, same as the
  // Management Dashboard.
  if (res?.props?.user && !['admin', 'manager'].includes(res.props.user.role)) {
    return { redirect: { destination: '/?forbidden=1', permanent: false } }
  }
  return res
}

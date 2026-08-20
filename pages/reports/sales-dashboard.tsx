// pages/reports/sales-dashboard.tsx
// Reports → Sales Dashboard — quote pipeline across the five rep Quote Channel
// boards. Portal rebuild of the Monday "Sales Dashboard" (2079976).
//
// view:reports, same as the Sales Report — this is pipeline and rep activity,
// not group turnover, so it isn't restricted to admin+manager the way the
// Management Dashboard and Forecast are.

import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import SalesDashboard from '../../components/reports/SalesDashboard'
import { requireReportPageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

export default function SalesDashboardPage({ user }: { user: PortalUserSSR }) {
  return (
    <>
      <Head><title>Sales Dashboard — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="sales-dashboard" role={user.role} reportTabs={user.visibleReportTabs} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <SalesDashboard />
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requireReportPageAuth(context, 'sales-dashboard')
}

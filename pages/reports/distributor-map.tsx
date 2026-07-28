// pages/reports/distributor-map.tsx
// Reports → Distributor Map — quotes done in each distributor's area vs the
// jobs they booked (Monday Distributor - Booking board, confirmed group),
// month by month. Dashboard component is client-only Leaflet.

import Head from 'next/head'
import dynamic from 'next/dynamic'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

const DistributorMapDashboard = dynamic(() => import('../../components/reports/DistributorMapDashboard'), { ssr: false })

export default function DistributorMapPage({ user }: { user: PortalUserSSR }) {
  return (
    <>
      <Head><title>Distributor Map — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="distributor-map" role={user.role} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <DistributorMapDashboard />
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}

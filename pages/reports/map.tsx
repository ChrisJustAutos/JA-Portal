// pages/reports/map.tsx
// Reports → Workshop Map — the Map & Conversion dashboard (booked jobs map,
// quotes map, quote→job conversion) fed by the daily MechanicDesk pull.
// The dashboard itself is components/workshop/WorkshopMapDashboard.tsx
// (client-only Leaflet, its own full-bleed dark styling).

import Head from 'next/head'
import dynamic from 'next/dynamic'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

const WorkshopMapDashboard = dynamic(() => import('../../components/workshop/WorkshopMapDashboard'), { ssr: false })

export default function WorkshopMapPage({ user }: { user: PortalUserSSR }) {
  return (
    <>
      <Head><title>Workshop Map — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="workshop-map" role={user.role} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <WorkshopMapDashboard />
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}

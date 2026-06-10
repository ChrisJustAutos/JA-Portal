// pages/admin/b2b/dropship-calibration.tsx
// Standalone page wrapper around the shared DropshipCalibrationPanel. The same
// panel is also rendered as a modal from the catalogue drop-ship freight editor.

import Head from 'next/head'
import PortalTopBar from '../../../lib/PortalTopBar'
import B2BAdminTabs from '../../../components/b2b/B2BAdminTabs'
import DropshipCalibrationPanel from '../../../components/b2b/DropshipCalibrationPanel'
import { requirePageAuth } from '../../../lib/authServer'
import type { UserRole } from '../../../lib/permissions'
import { T } from '../../../lib/ui/theme'

interface Props { user: { id: string; email: string; displayName: string | null; role: UserRole; visibleTabs: string[] | null } }

export default function DropshipCalibrationPage({ user }: Props) {
  return (
    <>
      <Head><title>Drop-ship freight calibration — B2B Admin</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: T.bg, color: T.text, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet"/>
        <PortalTopBar activeId="b2b" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <div style={{ flex: 1, padding: 20 }}>
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
            <B2BAdminTabs active="orders" />
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '18px 0 6px' }}>Drop-ship freight calibration</h1>
            <DropshipCalibrationPanel />
          </div>
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:b2b')
}

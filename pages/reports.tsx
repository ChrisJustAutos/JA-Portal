// pages/reports.tsx
// DIAGNOSTIC VERSION — barebones to isolate why the page is blank.
// Once we confirm this loads, we'll restore the full version.

import { useState } from 'react'
import Head from 'next/head'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import type { UserRole } from '../lib/permissions'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: UserRole }

export default function ReportsPage({ user }: { user: PortalUserSSR }) {
  const [clicked, setClicked] = useState(false)

  return (
    <>
      <Head><title>Reports — Just Autos</title></Head>
      <PortalSidebar
        activeId="reports"
        currentUserRole={user?.role}
        currentUserName={user?.displayName}
        currentUserEmail={user?.email}
      />
      <div style={{ background: '#0d0f12', minHeight: '100vh', color: '#e8eaf0', marginLeft: 260, padding: 40, fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Reports Page — Diagnostic</h1>
        <p style={{ color: '#8b90a0', marginTop: 8 }}>
          If you can see this text, the page is rendering correctly.
        </p>

        <div style={{ marginTop: 24, padding: 16, background: '#131519', borderRadius: 8, border: '1px solid rgba(255,255,255,0.07)' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>User info (from server):</h2>
          <pre style={{ fontSize: 12, color: '#8b90a0', marginTop: 8, background: '#0d0f12', padding: 12, borderRadius: 6 }}>
            {JSON.stringify(user, null, 2)}
          </pre>
        </div>

        <button
          onClick={() => setClicked(!clicked)}
          style={{
            marginTop: 20, padding: '10px 16px', borderRadius: 8, border: 'none',
            background: '#4f8ef7', color: '#fff', fontSize: 14, cursor: 'pointer',
          }}
        >
          Click me to test interactivity ({clicked ? 'Clicked!' : 'Not clicked'})
        </button>

        <p style={{ marginTop: 20, color: '#545968', fontSize: 12 }}>
          Once this diagnostic page loads properly, we'll restore the full Reports UI.
        </p>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'generate:reports')
}

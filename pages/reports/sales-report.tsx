// pages/reports/sales-report.tsx
// Reports → Sales Report — the latest Weekly Sales Recap (generated Mon 7am
// by the sales-recap GH-Actions runner). Renders the stored HTML; a "Run now"
// button triggers a fresh generation for admins.

import Head from 'next/head'
import { useEffect, useState } from 'react'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

export default function SalesReportPage({ user }: { user: PortalUserSSR }) {
  const [html, setHtml] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ week_start: string; generated_at: string; emailed_to: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/reports/sales-recap/latest')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErr(d.error); return }
        if (d.report) { setHtml(d.report.html); setMeta({ week_start: d.report.week_start, generated_at: d.report.generated_at, emailed_to: d.report.emailed_to }) }
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false))
  }, [])

  return (
    <>
      <Head><title>Sales Report — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <ReportsTabs active="sales-report" role={user.role} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px' }}>
          {loading && <div style={{ color: T.text2 }}>Loading latest recap…</div>}
          {err && <div style={{ color: '#d92d20' }}>Couldn’t load report: {err}</div>}
          {!loading && !err && !html && (
            <div style={{ color: T.text2, maxWidth: 640 }}>
              No recap generated yet. It runs automatically every <b>Monday 7am</b> and emails Ryan, Matt & Chris.
            </div>
          )}
          {html && (
            <div style={{ maxWidth: 860, margin: '0 auto' }}>
              {meta && <div style={{ color: T.text2, fontSize: 12, marginBottom: 10 }}>
                Week of {meta.week_start} · generated {new Date(meta.generated_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}{meta.emailed_to ? ` · emailed to ${meta.emailed_to}` : ''}
              </div>}
              <div style={{ background: '#fff', borderRadius: 8, padding: 20 }} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:reports')
}

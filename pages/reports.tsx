// pages/reports.tsx
// Reports page — pick report type, customise sections, preview, download PDF.

import { useState, useEffect, useMemo, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'
import {
  REPORT_TYPE_LABELS, REPORT_TYPE_DESCRIPTIONS,
  reportTypesForRole, type ReportType, type UserRole,
} from '../lib/permissions'
import {
  SECTION_META, DEFAULT_SECTIONS,
  type SectionId, type ReportConfig, type GeneratedReport,
} from '../lib/reports/spec'
import { useChatContext } from '../components/GlobalChatbot'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: UserRole }

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

const fmt = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000) return `$${Math.round(n / 1000)}k`
  return `$${Math.round(n).toLocaleString('en-AU')}`
}
const fmtFull = (n: number | null | undefined): string => {
  if (n == null || !isFinite(n)) return '—'
  return `$${Math.round(n).toLocaleString('en-AU')}`
}

function defaultPeriod() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`
  return { start, end }
}

export default function ReportsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const availableTypes = reportTypesForRole(user.role)
  const [selectedType, setSelectedType] = useState<ReportType | null>(availableTypes[0] || null)
  const { start: defStart, end: defEnd } = defaultPeriod()
  const [periodStart, setPeriodStart] = useState(defStart)
  const [periodEnd, setPeriodEnd] = useState(defEnd)
  const [entities, setEntities] = useState<('JAWS' | 'VPS')[]>(['JAWS', 'VPS'])
  const [customSections, setCustomSections] = useState<SectionId[] | null>(null)
  const [title, setTitle] = useState('')
  const [generating, setGenerating] = useState(false)
  const [downloadingPdf, setDownloadingPdf] = useState(false)
  const [report, setReport] = useState<GeneratedReport | null>(null)
  const [error, setError] = useState('')

  const defaultSections = useMemo<SectionId[]>(() => {
    return selectedType ? DEFAULT_SECTIONS[selectedType] : []
  }, [selectedType])

  const effectiveSections = customSections ?? defaultSections

  useEffect(() => {
    setCustomSections(null)
    setReport(null)
  }, [selectedType])

  const toggleSection = useCallback((sid: SectionId) => {
    setCustomSections(cs => {
      const current = cs ?? defaultSections
      return current.includes(sid) ? current.filter(s => s !== sid) : [...current, sid]
    })
  }, [defaultSections])

  const handleGenerate = useCallback(async () => {
    if (!selectedType) return
    setGenerating(true)
    setError('')
    setReport(null)
    try {
      const cfg: ReportConfig = {
        type: selectedType,
        periodStart, periodEnd, entities,
        sections: effectiveSections,
        title: title.trim() || undefined,
      }
      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setReport(await res.json() as GeneratedReport)
    } catch (err: any) {
      setError(err.message || 'Generate failed')
    } finally {
      setGenerating(false)
    }
  }, [selectedType, periodStart, periodEnd, entities, effectiveSections, title])

  const handleDownload = useCallback(async () => {
    if (!report) return
    setDownloadingPdf(true)
    setError('')
    try {
      const res = await fetch('/api/reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const cd = res.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename="?([^"]+)"?/)
      a.download = m?.[1] || 'report.pdf'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(err.message || 'Download failed')
    } finally {
      setDownloadingPdf(false)
    }
  }, [report])

  const { setPageContext } = useChatContext()
  useEffect(() => {
    if (!report) { setPageContext(null); return }
    setPageContext({
      reportTitle: report.title,
      reportType: report.type,
      period: `${report.periodStart} to ${report.periodEnd}`,
      entities: report.entities,
      sections: report.sections.map(s => s.id),
      hasNarrative: !!report.narrative,
    })
    return () => setPageContext(null)
  }, [report, setPageContext])

  // ── Render ─────────────────────────────────────────────────────────

  if (availableTypes.length === 0) {
    return (
      <>
        <Head><title>Reports — Just Autos</title></Head>
        <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
          <PortalSidebar activeId="reports" currentUserRole={user.role} currentUserName={user.displayName} currentUserEmail={user.email}/>
          <div style={{ flex: 1, padding: 40, overflowY: 'auto' }}>
            <h1 style={{ color: T.text, fontSize: 24 }}>Reports</h1>
            <p style={{ color: T.text2, maxWidth: 520 }}>Your role ({user.role}) doesn't have access to generate any report types. Contact an admin if you need access.</p>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Head><title>Reports — Just Autos</title></Head>
      <div style={{ display: 'flex', minHeight: '100vh', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalSidebar activeId="reports" currentUserRole={user.role} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>

          {/* Header */}
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ color: T.text, fontSize: 24, margin: 0, fontWeight: 700 }}>Reports</h1>
            <div style={{ color: T.text2, fontSize: 13, marginTop: 4 }}>
              Generate AI-assisted PDF reports from your live MYOB data.
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24, alignItems: 'flex-start' }}>

            {/* LEFT — configuration panel */}
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, position: 'sticky', top: 20 }}>
              <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Report type</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {availableTypes.map(rt => (
                  <button
                    key={rt}
                    onClick={() => setSelectedType(rt)}
                    style={{
                      textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                      background: selectedType === rt ? T.bg4 : T.bg3,
                      border: `1px solid ${selectedType === rt ? T.blue : T.border}`,
                      fontFamily: 'inherit', color: T.text,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{REPORT_TYPE_LABELS[rt]}</div>
                    <div style={{ fontSize: 10.5, color: T.text3, marginTop: 2, lineHeight: 1.3 }}>{REPORT_TYPE_DESCRIPTIONS[rt]}</div>
                  </button>
                ))}
              </div>

              {selectedType && (
                <>
                  <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Period</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                    <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} style={inputS}/>
                    <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} style={inputS}/>
                  </div>

                  <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Entities</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                    {(['JAWS', 'VPS'] as const).map(e => (
                      <label key={e} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: T.text }}>
                        <input
                          type="checkbox"
                          checked={entities.includes(e)}
                          onChange={() => setEntities(cur => cur.includes(e) ? cur.filter(x => x !== e) : [...cur, e])}
                        />
                        {e}
                      </label>
                    ))}
                  </div>

                  <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Sections</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
                    {(Object.keys(SECTION_META) as SectionId[]).map(sid => {
                      const isChecked = effectiveSections.includes(sid)
                      const meta = SECTION_META[sid]
                      return (
                        <label key={sid} style={{
                          display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                          padding: '4px 6px', borderRadius: 4,
                          background: isChecked ? T.bg3 : 'transparent',
                          opacity: isChecked ? 1 : 0.62,
                        }}>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSection(sid)}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11.5, color: T.text }}>{meta.label}</div>
                            <div style={{ fontSize: 9.5, color: T.text3, lineHeight: 1.3 }}>{meta.description}</div>
                          </div>
                        </label>
                      )
                    })}
                  </div>

                  <div style={{ fontSize: 11, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Custom title (optional)</div>
                  <input
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder={REPORT_TYPE_LABELS[selectedType]}
                    style={{ ...inputS, width: '100%', marginBottom: 16 }}
                  />

                  <button
                    onClick={handleGenerate}
                    disabled={generating || entities.length === 0 || effectiveSections.length === 0}
                    style={{
                      width: '100%', padding: '11px 14px', borderRadius: 8, border: 'none',
                      background: generating ? T.bg4 : T.blue,
                      color: '#fff', fontWeight: 600, fontSize: 13,
                      cursor: generating ? 'wait' : 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {generating ? 'Generating…' : 'Generate Preview'}
                  </button>
                  {error && (
                    <div style={{ marginTop: 10, padding: 8, background: `${T.red}18`, border: `1px solid ${T.red}40`, borderRadius: 6, color: T.red, fontSize: 11 }}>
                      {error}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* RIGHT — preview */}
            <div>
              {!report && !generating && (
                <div style={{ background: T.bg2, border: `1px dashed ${T.border2}`, borderRadius: 12, padding: '80px 40px', textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
                  <div style={{ color: T.text, fontSize: 15, fontWeight: 600, marginBottom: 6 }}>No preview yet</div>
                  <div style={{ color: T.text2, fontSize: 12, maxWidth: 380, margin: '0 auto' }}>
                    Pick a report type, adjust the period and sections, then click Generate Preview. The report will render here before you download it as PDF.
                  </div>
                </div>
              )}

              {generating && (
                <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 40, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: T.text, marginBottom: 8 }}>Fetching data and generating AI commentary…</div>
                  <div style={{ fontSize: 11, color: T.text3 }}>This can take 20–40 seconds depending on the sections included.</div>
                  <div style={{ margin: '18px auto 0', width: 36, height: 36, border: `3px solid ${T.border2}`, borderTopColor: T.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }}/>
                  <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                </div>
              )}

              {report && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 14px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{report.title}</div>
                      <div style={{ fontSize: 10.5, color: T.text3 }}>
                        {report.entities.join(' + ')} · {new Date(report.periodStart).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })} – {new Date(report.periodEnd).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })} · {report.sections.length} sections
                      </div>
                    </div>
                    <button
                      onClick={handleDownload}
                      disabled={downloadingPdf}
                      style={{
                        padding: '9px 16px', borderRadius: 8, border: 'none',
                        background: downloadingPdf ? T.bg4 : T.green,
                        color: '#fff', fontWeight: 600, fontSize: 12,
                        cursor: downloadingPdf ? 'wait' : 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {downloadingPdf ? 'Building PDF…' : 'Download PDF'}
                    </button>
                  </div>

                  <div style={{ background: '#ffffff', color: '#1a1d23', borderRadius: 10, padding: 32, fontFamily: "'Helvetica', sans-serif" }}>
                    <div style={{ borderBottom: '1px solid #d1d5db', paddingBottom: 14, marginBottom: 18 }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1d23' }}>{report.title}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        Just Autos · {report.entities.join(' + ')} · {new Date(report.periodStart).toLocaleDateString('en-AU')} – {new Date(report.periodEnd).toLocaleDateString('en-AU')}
                      </div>
                      <div style={{ fontSize: 10, color: '#6b7280', marginTop: 2 }}>
                        Generated {new Date(report.generatedAt).toLocaleString('en-AU')} · All amounts ex-GST
                      </div>
                    </div>

                    {report.narrative && (
                      <div style={{ background: '#f9fafb', padding: 14, borderLeft: '3px solid #2563eb', marginBottom: 16 }}>
                        <div style={{ fontSize: 10, color: '#2563eb', fontWeight: 700, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.08em' }}>AI Commentary</div>
                        {report.narrative.split(/\n\n+/).map((p, i) => (
                          <p key={i} style={{ fontSize: 12, lineHeight: 1.55, margin: '0 0 6px 0', color: '#1a1d23' }}>{p.trim()}</p>
                        ))}
                      </div>
                    )}

                    {report.sections.map(s => <PreviewSection key={s.id} section={s}/>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Preview section renderer ──────────────────────────────────────────
function PreviewSection({ section }: { section: any }) {
  if (!section || !section.data || section.data.error) {
    return (
      <div style={{ marginBottom: 14 }}>
        <h3 style={h3S}>{section.label}</h3>
        <div style={{ fontSize: 11, color: '#dc2626' }}>Data unavailable: {section.data?.error || 'unknown error'}</div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={h3S}>{section.label}</h3>
      <SectionBody section={section}/>
      {section.narrativeBeats && section.narrativeBeats.length > 0 && (
        <ul style={{ paddingLeft: 18, marginTop: 6 }}>
          {section.narrativeBeats.map((b: string, i: number) => (
            <li key={i} style={{ fontSize: 11.5, lineHeight: 1.5, marginBottom: 3 }}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function SectionBody({ section }: { section: any }) {
  switch (section.id as SectionId) {
    case 'kpi-summary': return <PvKpi data={section.data}/>
    case 'pnl-summary': return <PvPnl data={section.data}/>
    case 'top-customers': return <PvTopCustomers data={section.data}/>
    case 'receivables-aging': return <PvAging data={section.data} title="Receivables"/>
    case 'payables-aging': return <PvAging data={section.data} title="Payables"/>
    case 'stock-summary': return <PvStockSummary data={section.data}/>
    case 'stock-reorder': return <PvStockReorder data={section.data}/>
    case 'stock-dead': return <PvStockDead data={section.data}/>
    case 'distributor-ranking': return <PvDistributors data={section.data}/>
    case 'pipeline': return <PvPipeline data={section.data}/>
    case 'sales-pipeline-combined': return <PvSalesPipelineCombined data={section.data}/>
    case 'sales-funnel': return <PvSalesFunnel data={section.data}/>
    case 'sales-rep-scorecard': return <PvSalesRepScorecard data={section.data}/>
    case 'sales-rep-scorecard-v2': return <PvRepScorecardV2 data={section.data}/>
    case 'sales-quote-aging': return <PvQuoteAging data={section.data}/>
    case 'sales-month-trend': return <PvMonthTrend data={section.data}/>
    case 'trend-charts': return <PvTrends data={section.data}/>
    default: return null
  }
}

const h3S: React.CSSProperties = { fontSize: 14, fontWeight: 700, margin: '14px 0 8px', color: '#1a1d23' }
const thS: React.CSSProperties = { background: '#f3f4f6', padding: '5px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: '#3a3f4a', borderBottom: '1px solid #d1d5db' }
const tdS: React.CSSProperties = { padding: '4px 8px', fontSize: 11, color: '#1a1d23', borderBottom: '1px solid #e5e7eb' }
const inputS: React.CSSProperties = { flex: 1, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 6, padding: '7px 9px', color: T.text, fontSize: 12, fontFamily: 'inherit' }

function PvKpi({ data }: { data: any }) {
  return (
    <div>
      {data.entities.map((e: any, i: number) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>{e.entity}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <KpiCell label="Revenue" value={fmt(e.revenueExGst)} sub="Period"/>
            <KpiCell label="Net" value={fmt(e.netExGst)} sub="After overheads"/>
            <KpiCell label="Receivables" value={fmt(e.receivablesExGst)} sub={`${e.openInvoiceCount} open`}/>
            <KpiCell label="Payables" value={fmt(e.payablesExGst)} sub={`${e.openBillCount} open`}/>
            {e.stockValueExGst != null && <KpiCell label="Stock" value={fmt(e.stockValueExGst)} sub="On hand"/>}
            <KpiCell label="Income" value={fmt(e.incomeFromPnlExGst)} sub="P&L 4-"/>
            <KpiCell label="COS" value={fmt(e.cosFromPnlExGst)} sub="P&L 5-"/>
            {e.overheadsFromPnlExGst > 0 && <KpiCell label="Overheads" value={fmt(e.overheadsFromPnlExGst)} sub="P&L 6-"/>}
          </div>
        </div>
      ))}
    </div>
  )
}
function KpiCell({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#f9fafb', padding: 8, borderTop: '2px solid #2563eb' }}>
      <div style={{ fontSize: 8.5, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#1a1d23', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 8.5, color: '#6b7280', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function PvPnl({ data }: { data: any }) {
  return (
    <div>
      {data.entities.map((e: any, i: number) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>{e.entity}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thS}>Account</th><th style={{ ...thS, width: 70 }}>Code</th><th style={{ ...thS, textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {e.income.slice(0, 8).map((r: any, ii: number) => (
                <tr key={ii}><td style={tdS}>{r.account}</td><td style={{ ...tdS, color: '#6b7280' }}>{r.code}</td><td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(r.amount)}</td></tr>
              ))}
              <tr><td style={{ ...tdS, fontWeight: 700, borderTop: '1px solid #1a1d23' }}>Total Income</td><td style={{ ...tdS, borderTop: '1px solid #1a1d23' }}></td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, borderTop: '1px solid #1a1d23' }}>{fmtFull(e.totalIncome)}</td></tr>
              {e.totalCos > 0 && <tr><td style={tdS}>– Cost of Sales</td><td style={tdS}></td><td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(e.totalCos)}</td></tr>}
              <tr><td style={{ ...tdS, fontWeight: 700 }}>Gross Profit</td><td style={tdS}></td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: e.grossProfit >= 0 ? '#059669' : '#dc2626' }}>{fmtFull(e.grossProfit)}</td></tr>
              {e.totalOverheads > 0 && <tr><td style={tdS}>– Overheads</td><td style={tdS}></td><td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(e.totalOverheads)}</td></tr>}
              <tr><td style={{ ...tdS, fontWeight: 700, borderTop: '1px solid #1a1d23' }}>Net Profit</td><td style={{ ...tdS, borderTop: '1px solid #1a1d23' }}></td><td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: e.netProfit >= 0 ? '#059669' : '#dc2626', borderTop: '1px solid #1a1d23' }}>{fmtFull(e.netProfit)}</td></tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function PvTopCustomers({ data }: { data: any }) {
  return (
    <div>
      {data.entities.map((e: any, i: number) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>{e.entity}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thS}>#</th><th style={thS}>Customer</th><th style={{ ...thS, textAlign: 'right' }}>Invs</th><th style={{ ...thS, textAlign: 'right' }}>Revenue</th></tr></thead>
            <tbody>
              {e.customers.map((c: any, ii: number) => (
                <tr key={ii}><td style={{ ...tdS, color: '#6b7280' }}>{ii + 1}</td><td style={tdS}>{c.name}</td><td style={{ ...tdS, textAlign: 'right' }}>{c.invoiceCount}</td><td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(c.revenueExGst)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

function PvAging({ data, title }: { data: any; title: string }) {
  return (
    <div>
      {data.entities.map((e: any, idx: number) => (
        <div key={idx} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>
            {e.entity} — {title} total {fmtFull(e.total)}
          </div>
          <div style={{ display: 'flex', marginBottom: 6, borderRadius: 3, overflow: 'hidden' }}>
            {[
              { label: '0-30d', v: e.buckets.current, color: '#0d9488' },
              { label: '31-60d', v: e.buckets.days30, color: '#2563eb' },
              { label: '61-90d', v: e.buckets.days60, color: '#d97706' },
              { label: '91+d', v: e.buckets.days90, color: '#dc2626' },
            ].filter(b => b.v > 0 && e.total > 0).map((b, i) => (
              <div key={i} style={{ flex: b.v / e.total, background: b.color, padding: '4px 6px', color: '#fff' }}>
                <div style={{ fontSize: 9, fontWeight: 700 }}>{b.label}</div>
                <div style={{ fontSize: 10, fontWeight: 700 }}>{fmt(b.v)}</div>
              </div>
            ))}
          </div>
          {e.oldest.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thS}>Customer/Supplier</th><th style={thS}>Invoice</th><th style={thS}>Date</th><th style={{ ...thS, textAlign: 'right' }}>Days</th><th style={{ ...thS, textAlign: 'right' }}>Balance</th></tr></thead>
              <tbody>
                {e.oldest.map((o: any, i: number) => (
                  <tr key={i}>
                    <td style={tdS}>{o.customerOrSupplier}</td>
                    <td style={{ ...tdS, color: '#6b7280' }}>{o.invoiceNumber}</td>
                    <td style={{ ...tdS, color: '#6b7280' }}>{o.date ? new Date(o.date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }) : ''}</td>
                    <td style={{ ...tdS, textAlign: 'right', color: o.daysOld > 90 ? '#dc2626' : '#1a1d23' }}>{o.daysOld}</td>
                    <td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(o.balanceExGst)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  )
}

function PvStockSummary({ data }: { data: any }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      <KpiCell label="Total stock value" value={fmt(data.totalValueExGst)} sub="Ex-GST, on hand"/>
      <KpiCell label="Total items" value={String(data.itemCount || 0)} sub="Inventoried"/>
      <KpiCell label="Below reorder" value={String(data.itemsBelowReorder || 0)} sub={data.itemsBelowReorder > 0 ? 'Needs attention' : 'All good'}/>
    </div>
  )
}

function PvStockReorder({ data }: { data: any }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th style={thS}>Item</th><th style={thS}>SKU</th><th style={{ ...thS, textAlign: 'right' }}>On hand</th><th style={{ ...thS, textAlign: 'right' }}>Reorder</th><th style={{ ...thS, textAlign: 'right' }}>Short by</th></tr></thead>
      <tbody>
        {data.items.slice(0, 20).map((r: any, i: number) => (
          <tr key={i}><td style={tdS}>{r.name}</td><td style={{ ...tdS, color: '#6b7280' }}>{r.sku}</td><td style={{ ...tdS, textAlign: 'right' }}>{r.onHand}</td><td style={{ ...tdS, textAlign: 'right' }}>{r.reorderLevel}</td><td style={{ ...tdS, textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>{r.shortBy}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

function PvStockDead({ data }: { data: any }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#6b7280', marginBottom: 4 }}>Items not sold in 90+ days. Total held: {fmtFull(data.totalHeldValueExGst)}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr><th style={thS}>Item</th><th style={thS}>SKU</th><th style={{ ...thS, textAlign: 'right' }}>On hand</th><th style={{ ...thS, textAlign: 'right' }}>Value held</th></tr></thead>
        <tbody>
          {data.items.slice(0, 20).map((r: any, i: number) => (
            <tr key={i}><td style={tdS}>{r.name}</td><td style={{ ...tdS, color: '#6b7280' }}>{r.sku}</td><td style={{ ...tdS, textAlign: 'right' }}>{r.onHand}</td><td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(r.heldValueExGst)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PvDistributors({ data }: { data: any }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>
        <th style={thS}>#</th>
        <th style={thS}>Distributor</th>
        <th style={{ ...thS, textAlign: 'right' }}>Tuning</th>
        <th style={{ ...thS, textAlign: 'right' }}>Parts</th>
        <th style={{ ...thS, textAlign: 'right' }}>Oil</th>
        <th style={{ ...thS, textAlign: 'right' }}>Total</th>
        <th style={{ ...thS, textAlign: 'right' }}>Invs</th>
      </tr></thead>
      <tbody>
        {data.distributors.slice(0, 25).map((d: any, i: number) => (
          <tr key={i}>
            <td style={{ ...tdS, color: '#6b7280' }}>{i + 1}</td>
            <td style={tdS}>{d.name}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{fmt(d.tuning)}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{fmt(d.parts)}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{fmt(d.oil)}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(d.total)}</td>
            <td style={{ ...tdS, textAlign: 'right', color: '#6b7280' }}>{d.invoiceCount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PvRepScorecardV2({ data }: { data: any }) {
  const attr = data?.attribution
  if (!attr) {
    return <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>
      Attribution data unavailable — Connect column may not be populated yet, or Monday API was unreachable.
    </div>
  }
  const { linkageCompleteness, repScorecard, teamTotals } = attr

  return (
    <div>
      {/* Linkage completeness banner */}
      <div style={{ padding: '8px 12px', background: linkageCompleteness.pct < 50 ? '#fff7ed' : linkageCompleteness.pct < 80 ? '#fefce8' : '#f0fdf4', border: `1px solid ${linkageCompleteness.pct < 50 ? '#fed7aa' : linkageCompleteness.pct < 80 ? '#fde047' : '#bbf7d0'}`, borderRadius: 4, marginBottom: 10, fontSize: 11 }}>
        <strong>Tracking completeness: {linkageCompleteness.pct}%</strong>
        {' '}— {linkageCompleteness.ordersWithLink} of {linkageCompleteness.ordersInPeriod} orders in period are linked to a quote.
        {linkageCompleteness.pct < 80 && <span style={{ color: '#92400e' }}> Numbers will improve as backfill completes.</span>}
        {!linkageCompleteness.distBookingConnectEnabled && <span style={{ color: '#6b7280', display: 'block', marginTop: 2, fontSize: 10 }}>Distributor Booking → Quote Connect column not yet added; dist bookings all show as unlinked.</span>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '2px solid #1a1d23' }}>
            <th style={{ ...thS, textAlign: 'left' }} colSpan={1}>Rep</th>
            <th style={{ ...thS, textAlign: 'center', background: '#dbeafe' }} colSpan={3}>Quote-month view</th>
            <th style={{ ...thS, textAlign: 'center', background: '#dcfce7' }} colSpan={3}>Order-month view</th>
          </tr>
          <tr>
            <th style={thS}></th>
            <th style={{ ...thS, textAlign: 'right', background: '#eff6ff' }}>Sent</th>
            <th style={{ ...thS, textAlign: 'right', background: '#eff6ff' }}>Conv.</th>
            <th style={{ ...thS, textAlign: 'right', background: '#eff6ff' }}>QM %</th>
            <th style={{ ...thS, textAlign: 'right', background: '#f0fdf4' }}>Orders</th>
            <th style={{ ...thS, textAlign: 'right', background: '#f0fdf4' }}>Value</th>
            <th style={{ ...thS, textAlign: 'right', background: '#f0fdf4' }}>From prior</th>
          </tr>
        </thead>
        <tbody>
          {repScorecard.map((r: any, i: number) => (
            <tr key={i}>
              <td style={tdS}>{r.fullName || r.rep}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{r.quotesSentInPeriod}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{r.quotesSentConverted}</td>
              <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: r.quoteMonthConversionPct == null ? '#6b7280' : r.quoteMonthConversionPct >= 50 ? '#059669' : r.quoteMonthConversionPct >= 25 ? '#d97706' : '#dc2626' }}>
                {r.quoteMonthConversionPct == null ? '—' : `${r.quoteMonthConversionPct}%`}
              </td>
              <td style={{ ...tdS, textAlign: 'right' }}>{r.ordersLinkedToRep}</td>
              <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(r.ordersLinkedValue)}</td>
              <td style={{ ...tdS, textAlign: 'right', color: '#6b7280' }}>{r.ordersLinkedFromPriorQuotes}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '2px solid #1a1d23' }}>
            <td style={{ ...tdS, fontWeight: 700 }}>Team</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{teamTotals.quotesSentInPeriod}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{teamTotals.quotesSentConverted}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{teamTotals.quoteMonthConversionPct == null ? '—' : `${teamTotals.quoteMonthConversionPct}%`}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{teamTotals.ordersLinked}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(teamTotals.ordersLinkedValue)}</td>
            <td style={tdS}></td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontSize: 9.5, color: '#6b7280', marginTop: 6, lineHeight: 1.4 }}>
        <strong>Sent</strong> = quotes created this period · <strong>Conv.</strong> = of those, already linked to an order · <strong>QM %</strong> = quote-month conversion<br/>
        <strong>Orders</strong> = orders this period linked to this rep's quotes · <strong>From prior</strong> = orders linked to quotes from earlier months
      </div>
    </div>
  )
}

function PvQuoteAging({ data }: { data: any }) {
  const attr = data?.attribution
  if (!attr) {
    return <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>Attribution data unavailable.</div>
  }
  const { quoteAging } = attr
  const total = quoteAging.sameMonth.count + quoteAging.last30d.count + quoteAging.last60d.count + quoteAging.older.count + quoteAging.unlinked.count
  const totalValue = quoteAging.sameMonth.value + quoteAging.last30d.value + quoteAging.last60d.value + quoteAging.older.value + quoteAging.unlinked.value

  const buckets = [
    { label: 'Same month', count: quoteAging.sameMonth.count, value: quoteAging.sameMonth.value, color: '#059669' },
    { label: '≤ 30 days ago', count: quoteAging.last30d.count, value: quoteAging.last30d.value, color: '#0284c7' },
    { label: '31-60 days ago', count: quoteAging.last60d.count, value: quoteAging.last60d.value, color: '#d97706' },
    { label: '60+ days ago', count: quoteAging.older.count, value: quoteAging.older.value, color: '#dc2626' },
    { label: 'Unlinked (walk-in or untracked)', count: quoteAging.unlinked.count, value: quoteAging.unlinked.value, color: '#6b7280' },
  ]

  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#6b7280', marginBottom: 8 }}>
        For each order placed in the period, how old was its originating quote? Answers lead-time questions.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thS}>Quote age at time of order</th>
            <th style={{ ...thS, textAlign: 'right' }}>Count</th>
            <th style={{ ...thS, textAlign: 'right' }}>Value</th>
            <th style={{ ...thS, textAlign: 'right' }}>% of orders</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => {
            const pct = total > 0 ? Math.round((b.count / total) * 100) : 0
            return (
              <tr key={i}>
                <td style={tdS}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, background: b.color, borderRadius: 2, marginRight: 6 }}/>
                  {b.label}
                </td>
                <td style={{ ...tdS, textAlign: 'right' }}>{b.count}</td>
                <td style={{ ...tdS, textAlign: 'right' }}>{fmt(b.value)}</td>
                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{pct}%</td>
              </tr>
            )
          })}
          <tr style={{ borderTop: '2px solid #1a1d23' }}>
            <td style={{ ...tdS, fontWeight: 700 }}>Total</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{total}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(totalValue)}</td>
            <td style={tdS}></td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function PvMonthTrend({ data }: { data: any }) {
  const attr = data?.attribution
  if (!attr) {
    return <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>Attribution data unavailable.</div>
  }
  const { priorMonths } = attr
  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#6b7280', marginBottom: 8 }}>
        Quote-month conversion trend. Older months should have higher % as quotes had more time to close; recent months may still be maturing.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thS}>Month</th>
            <th style={{ ...thS, textAlign: 'right' }}>Quotes sent</th>
            <th style={{ ...thS, textAlign: 'right' }}>Converted (to date)</th>
            <th style={{ ...thS, textAlign: 'right' }}>Conversion %</th>
          </tr>
        </thead>
        <tbody>
          {priorMonths.map((m: any, i: number) => (
            <tr key={i}>
              <td style={tdS}>{m.label}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{m.quotesSent}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{m.quotesConvertedToDate}</td>
              <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: m.conversionPct == null ? '#6b7280' : m.conversionPct >= 50 ? '#059669' : m.conversionPct >= 25 ? '#d97706' : '#dc2626' }}>
                {m.conversionPct == null ? '—' : `${m.conversionPct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 9.5, color: '#6b7280', marginTop: 4, fontStyle: 'italic' }}>
        Note: This only counts conversions to orders placed within the report period. For a complete multi-month trend, we'd need to broaden the order fetch scope.
      </div>
    </div>
  )
}

function PvSalesPipelineCombined({ data }: { data: any }) {
  const myob = data?.myob || {}
  const monday = data?.monday
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>MYOB</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
        <KpiCell label="Open orders" value={String(myob.openOrdersCount || 0)} sub={fmt(myob.openOrdersValueExGst)}/>
        <KpiCell label="Owing" value={fmt(myob.openOrdersOwingExGst)} sub="Balance"/>
        <KpiCell label="Converted 30d" value={String(myob.convertedCount30d || 0)} sub={fmt(myob.convertedValue30dExGst)}/>
        <KpiCell label="Open quotes" value={String(myob.quotesCount || 0)} sub={fmt(myob.quotesValueExGst)}/>
      </div>
      {monday ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>Monday.com</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 10 }}>
            <KpiCell label="Active leads" value={String(monday.activeLeadsTotal || 0)} sub="Current"/>
            <KpiCell label="Quotes sent" value={String(monday.quotesSentTotal || 0)} sub={fmt(monday.quotesSentValue)}/>
            <KpiCell label="Period orders" value={String(monday.ordersThisPeriodCount || 0)} sub={fmt(monday.ordersThisPeriodValue)}/>
          </div>
          {monday.activeLeadsByStatus?.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#3a3f4a', marginBottom: 4 }}>Active leads by status</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thS}>Status</th><th style={{ ...thS, textAlign: 'right' }}>Count</th></tr></thead>
                <tbody>
                  {monday.activeLeadsByStatus.slice(0, 8).map((r: any, i: number) => (
                    <tr key={i}><td style={tdS}>{r.status}</td><td style={{ ...tdS, textAlign: 'right' }}>{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      ) : (
        <div style={{ fontSize: 11, color: '#d97706', fontStyle: 'italic', marginTop: 6 }}>Monday.com data unavailable — showing MYOB only.</div>
      )}
    </div>
  )
}

function PvSalesFunnel({ data }: { data: any }) {
  const stages = data?.stages || []
  const conversions = data?.conversions || []
  const maxCount = Math.max(1, ...stages.map((s: any) => s.count))
  return (
    <div>
      <div style={{ fontSize: 10.5, color: '#6b7280', marginBottom: 8 }}>
        Leads, quotes and orders flowing through the sales pipeline.
      </div>
      {stages.map((s: any, i: number) => {
        const barW = maxCount > 0 ? (s.count / maxCount) * 100 : 0
        const color = s.source === 'MYOB' ? '#059669' : '#2563eb'
        return (
          <div key={i} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 3 }}>
              <div style={{ fontSize: 11, fontWeight: 700, flex: 2.5 }}>{s.label}</div>
              <div style={{ fontSize: 9.5, color: '#6b7280', flex: 1.5 }}>{s.source}{s.note ? ` — ${s.note}` : ''}</div>
              <div style={{ fontSize: 11, fontWeight: 700, flex: 1, textAlign: 'right' }}>{s.count}</div>
              <div style={{ fontSize: 11, flex: 1.2, textAlign: 'right', color: '#3a3f4a' }}>{fmt(s.value)}</div>
            </div>
            <div style={{ height: 8, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${barW}%`, height: 8, background: color }}/>
            </div>
          </div>
        )
      })}
      {conversions.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid #d1d5db' }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, color: '#3a3f4a' }}>Conversion rates</div>
          {conversions.map((c: any, i: number) => (
            <div key={i} style={{ display: 'flex', marginBottom: 2 }}>
              <div style={{ fontSize: 10.5, flex: 3, color: '#3a3f4a' }}>{c.from} → {c.to}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: c.pct >= 50 ? '#059669' : c.pct >= 25 ? '#d97706' : '#dc2626' }}>{c.pct}%</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PvSalesRepScorecard({ data }: { data: any }) {
  const reps = data?.reps || []
  const totals = data?.totals || {}
  if (reps.length === 0) {
    return <div style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>No Monday.com data available.</div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>
        <th style={thS}>Rep</th>
        <th style={{ ...thS, textAlign: 'right' }}>Leads</th>
        <th style={{ ...thS, textAlign: 'right' }}>Sent #</th>
        <th style={{ ...thS, textAlign: 'right' }}>Sent $</th>
        <th style={{ ...thS, textAlign: 'right' }}>Won #</th>
        <th style={{ ...thS, textAlign: 'right' }}>Won $</th>
        <th style={{ ...thS, textAlign: 'right' }}>Lost</th>
        <th style={{ ...thS, textAlign: 'right' }}>Conv %</th>
      </tr></thead>
      <tbody>
        {reps.map((r: any, i: number) => (
          <tr key={i}>
            <td style={tdS}>{r.fullName || r.rep}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{r.activeLeads}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{r.quotesSent}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{fmt(r.quotesSentValue)}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{r.quotesWon}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(r.quotesWonValue)}</td>
            <td style={{ ...tdS, textAlign: 'right' }}>{r.quotesLost}</td>
            <td style={{ ...tdS, textAlign: 'right', fontWeight: 700, color: r.conversionPct == null ? '#6b7280' : r.conversionPct >= 50 ? '#059669' : r.conversionPct >= 25 ? '#d97706' : '#dc2626' }}>
              {r.conversionPct == null ? '—' : `${r.conversionPct}%`}
            </td>
          </tr>
        ))}
        <tr style={{ borderTop: '2px solid #1a1d23' }}>
          <td style={{ ...tdS, fontWeight: 700 }}>Team totals</td>
          <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{totals.activeLeads || 0}</td>
          <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{totals.quotesSent || 0}</td>
          <td style={tdS}></td>
          <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{totals.quotesWon || 0}</td>
          <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(totals.quotesWonValue)}</td>
          <td style={tdS}></td>
          <td style={tdS}></td>
        </tr>
      </tbody>
    </table>
  )
}

function PvPipeline({ data }: { data: any }) {
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
        <KpiCell label="Open orders" value={String(data.openOrdersCount || 0)} sub={fmt(data.openOrdersValueExGst)}/>
        <KpiCell label="Owing on orders" value={fmt(data.openOrdersOwingExGst)} sub="Balance"/>
        <KpiCell label="Converted 30d" value={String(data.convertedCount30d || 0)} sub={fmt(data.convertedValue30dExGst)}/>
        <KpiCell label="Open quotes" value={String(data.quotesCount || 0)} sub={fmt(data.quotesValueExGst)}/>
      </div>
      {data.topOpenOrders?.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#3a3f4a', marginBottom: 4 }}>Top open orders</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={thS}>Order</th><th style={thS}>Customer</th><th style={thS}>Date</th><th style={{ ...thS, textAlign: 'right' }}>Value</th><th style={{ ...thS, textAlign: 'right' }}>Status</th></tr></thead>
            <tbody>
              {data.topOpenOrders.map((o: any, i: number) => (
                <tr key={i}>
                  <td style={{ ...tdS, color: '#6b7280' }}>{o.number}</td>
                  <td style={tdS}>{o.customer}</td>
                  <td style={{ ...tdS, color: '#6b7280' }}>{o.date ? new Date(o.date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }) : ''}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{fmtFull(o.valueExGst)}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontSize: 9, color: o.isPrepaid ? '#059669' : '#d97706', fontWeight: 700 }}>{o.isPrepaid ? 'PREPAID' : 'OWING'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function PvTrends({ data }: { data: any }) {
  const months: string[] = data?.months || []
  const entities = data?.entities || []
  if (months.length === 0) return null
  let maxVal = 1
  for (const e of entities) for (const v of [...e.income, ...e.expenses]) if (v > maxVal) maxVal = v
  const w = 560, h = 130
  const pad = { top: 8, right: 8, bottom: 22, left: 48 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom
  const xStep = plotW / Math.max(months.length - 1, 1)
  const yFor = (v: number) => pad.top + plotH - (v / maxVal) * plotH
  return (
    <div>
      {entities.map((e: any, idx: number) => {
        const incomePts = e.income.map((v: number, i: number) => `${pad.left + xStep * i},${yFor(v)}`).join(' ')
        const expensePts = e.expenses.map((v: number, i: number) => `${pad.left + xStep * i},${yFor(v)}`).join(' ')
        return (
          <div key={idx} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#3a3f4a' }}>{e.entity} — 6-month trend</div>
            <svg width={w} height={h} style={{ maxWidth: '100%', height: 'auto' }}>
              <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + plotH} stroke="#d1d5db" strokeWidth="0.5"/>
              <line x1={pad.left} y1={pad.top + plotH} x2={pad.left + plotW} y2={pad.top + plotH} stroke="#d1d5db" strokeWidth="0.5"/>
              {[0, 0.5, 1].map((f, i) => (
                <g key={i}>
                  <line x1={pad.left} y1={pad.top + plotH * (1 - f)} x2={pad.left + plotW} y2={pad.top + plotH * (1 - f)} stroke="#e5e7eb" strokeWidth="0.3"/>
                  <text x={pad.left - 4} y={pad.top + plotH * (1 - f) + 3} fontSize="9" fill="#6b7280" textAnchor="end">{fmt(maxVal * f)}</text>
                </g>
              ))}
              {months.map((m: string, i: number) => (
                <text key={i} x={pad.left + xStep * i} y={pad.top + plotH + 14} fontSize="9" fill="#6b7280" textAnchor="middle">{m}</text>
              ))}
              <polyline points={incomePts} fill="none" stroke="#059669" strokeWidth="1.4"/>
              <polyline points={expensePts} fill="none" stroke="#dc2626" strokeWidth="1.4" strokeDasharray="3,2"/>
            </svg>
            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: '#6b7280', marginLeft: pad.left }}>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#059669', verticalAlign: 'middle', marginRight: 4 }}/>Income</span>
              <span><span style={{ display: 'inline-block', width: 10, height: 2, background: '#dc2626', verticalAlign: 'middle', marginRight: 4 }}/>Expenses</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'generate:reports')
}

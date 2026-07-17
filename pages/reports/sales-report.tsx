// pages/reports/sales-report.tsx
// Reports → Sales Report — a LIVE Weekly Sales Recap. Order/booking figures
// (sections 1-3 + flags) are pulled fresh from Monday on every load via
// /api/reports/sales-recap/live; the workshop forecast + diary come from the
// last scrape and show an "as of" time. Toggle This week / Last week or pick a
// custom date range, refresh on demand, kick off a workshop-data refresh, or
// export the report as a PDF. The same report auto-emails Ryan every Mon 7am.

import Head from 'next/head'
import { useEffect, useState, useCallback } from 'react'
import PortalTopBar from '../../lib/PortalTopBar'
import ReportsTabs from '../../components/ReportsTabs'
import { requirePageAuth } from '../../lib/authServer'
import type { PortalUserSSR } from '../../lib/authServer'
import { T } from '../../lib/ui/theme'

type WeekMode = 'previous' | 'current' | 'custom'

function relTime(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

export default function SalesReportPage({ user }: { user: PortalUserSSR }) {
  const [weekMode, setWeekMode] = useState<WeekMode>('previous')
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const [html, setHtml] = useState<string | null>(null)
  const [reportWeek, setReportWeek] = useState<{ start: string; end: string } | null>(null)
  const [ordersAsOf, setOrdersAsOf] = useState<string | null>(null)
  const [workshopAsOf, setWorkshopAsOf] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'refresh' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportHover, setExportHover] = useState<number | null>(null)

  const load = useCallback(async (mode: WeekMode, range?: { start: string; end: string }) => {
    setLoading(true); setErr(null)
    try {
      const qs = mode === 'custom' && range
        ? `start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}`
        : `week=${mode}`
      const r = await fetch(`/api/reports/sales-recap/live?${qs}`)
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setHtml(d.html)
      setReportWeek(d.recap?.week || null)
      setOrdersAsOf(d.ordersAsOf || null)
      setWorkshopAsOf(d.workshopAsOf || null)
    } catch (e: any) {
      setErr(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (weekMode !== 'custom') load(weekMode)
  }, [weekMode, load])

  const rangeValid = /^\d{4}-\d{2}-\d{2}$/.test(rangeStart) && /^\d{4}-\d{2}-\d{2}$/.test(rangeEnd) && rangeStart <= rangeEnd
  function applyRange() {
    if (!rangeValid) return
    setWeekMode('custom')
    load('custom', { start: rangeStart, end: rangeEnd })
  }

  function refresh() {
    if (weekMode === 'custom') {
      if (rangeValid) load('custom', { start: rangeStart, end: rangeEnd })
    } else load(weekMode)
  }

  async function runWorkshop() {
    setBusy('refresh'); setNote(null)
    try {
      const r = await fetch('/api/reports/sales-recap/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.detail || d.error || `HTTP ${r.status}`)
      setNote('Workshop data refresh started (~4 min). Hit Refresh below once it finishes to pull the new forecast & diary.')
    } catch (e: any) {
      setNote(`Couldn’t start: ${String(e.message || e)}`)
    } finally {
      setBusy(null)
    }
  }

  // Every export flavour wraps the SAME report HTML in a standalone document,
  // so they all match the emailed report exactly. The Office namespaces are
  // inert in browsers but let Word open the .doc download cleanly.
  function reportDoc(): { title: string; doc: string } | null {
    if (!html) return null
    const title = reportWeek ? `Sales Report ${reportWeek.start} to ${reportWeek.end}` : 'Sales Report'
    const doc = `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:24px;background:#fff} @media print{body{margin:0}}</style>
</head><body>${html}</body></html>`
    return { title, doc }
  }

  // The BOM prefix keeps Word from mis-reading the UTF-8 (→ · en-dashes etc).
  function downloadFile(content: string, mime: string, filename: string) {
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff), content], { type: mime }))
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  // PDF = open in a print window; the browser's "Save as PDF" destination is
  // the export. Zero server-side PDF dependencies.
  function exportPdf() {
    const r = reportDoc()
    if (!r) return
    const w = window.open('', '_blank')
    if (!w) { setNote('Pop-up blocked — allow pop-ups for the portal to export a PDF.'); return }
    w.document.write(r.doc)
    w.document.close()
    w.focus()
    // Give the new window a beat to lay out before opening the print dialog.
    setTimeout(() => { try { w.print() } catch { /* user can print manually */ } }, 400)
  }

  // Word opens HTML served as application/msword natively (tables, colours and
  // all) — no converter needed, and the file forwards/edits fine from there.
  function exportWord() {
    const r = reportDoc()
    if (r) downloadFile(r.doc, 'application/msword', `${r.title}.doc`)
  }

  function exportHtml() {
    const r = reportDoc()
    if (r) downloadFile(r.doc, 'text/html', `${r.title}.html`)
  }

  const EXPORTS: { label: string; hint: string; run: () => void }[] = [
    { label: 'PDF', hint: 'print window → Save as PDF', run: exportPdf },
    { label: 'Word (.doc)', hint: 'editable, opens in Word', run: exportWord },
    { label: 'HTML file', hint: 'self-contained web page', run: exportHtml },
  ]

  const btn = (active: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? T.blue : T.border}`, background: active ? 'rgba(79,142,247,0.15)' : T.bg3,
    color: active ? T.blue : T.text2, whiteSpace: 'nowrap',
  })
  const actionBtn = (disabled: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '6px 12px', borderRadius: 6, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
    border: `1px solid ${T.border}`, background: T.bg3, color: disabled ? T.text3 : T.text2, whiteSpace: 'nowrap', opacity: disabled ? 0.7 : 1,
  })
  const dateInput: React.CSSProperties = {
    fontSize: 12, padding: '5px 8px', borderRadius: 6, fontFamily: 'inherit',
    border: `1px solid ${T.border}`, background: T.bg3, color: T.text2, colorScheme: 'dark',
  }

  return (
    <>
      <Head><title>Sales Report — Just Autos</title><meta name="robots" content="noindex,nofollow" /></Head>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans', system-ui, sans-serif", background: T.bg, color: T.text }}>
        <PortalTopBar activeId="reports" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email} />
        <ReportsTabs active="sales-report" role={user.role} />

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 16px', background: T.bg2, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: T.text3, marginRight: 2 }}>Week</span>
          <button style={btn(weekMode === 'previous')} onClick={() => setWeekMode('previous')}>Last week</button>
          <button style={btn(weekMode === 'current')} onClick={() => setWeekMode('current')}>This week (to date)</button>

          <div style={{ width: 1, height: 20, background: T.border, margin: '0 4px' }} />

          <span style={{ fontSize: 11, color: T.text3 }}>Range</span>
          <input type="date" style={dateInput} value={rangeStart} max={rangeEnd || undefined} onChange={e => setRangeStart(e.target.value)} />
          <span style={{ fontSize: 11, color: T.text3 }}>→</span>
          <input type="date" style={dateInput} value={rangeEnd} min={rangeStart || undefined} onChange={e => setRangeEnd(e.target.value)} />
          <button style={weekMode === 'custom' ? btn(true) : actionBtn(!rangeValid)} disabled={!rangeValid} onClick={applyRange}>Apply</button>

          <div style={{ width: 1, height: 20, background: T.border, margin: '0 4px' }} />

          <button style={actionBtn(loading)} disabled={loading} onClick={refresh}>
            {loading ? 'Loading…' : '↻ Refresh'}
          </button>
          <button style={actionBtn(!!busy)} disabled={!!busy} onClick={runWorkshop}>
            {busy === 'refresh' ? 'Starting…' : 'Update workshop data'}
          </button>
          <div style={{ position: 'relative' }}>
            <button style={actionBtn(!html)} disabled={!html} onClick={() => setExportOpen(o => !o)}>
              ⬇ Export ▾
            </button>
            {exportOpen && (
              <>
                {/* click-away backdrop */}
                <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setExportOpen(false)} />
                <div style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 41, minWidth: 210,
                  background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 8,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.35)', overflow: 'hidden',
                }}>
                  {EXPORTS.map((x, i) => (
                    <button
                      key={x.label}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
                        fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', border: 'none',
                        background: exportHover === i ? T.bg3 : 'transparent', color: T.text,
                      }}
                      onMouseEnter={() => setExportHover(i)}
                      onMouseLeave={() => setExportHover(null)}
                      onClick={() => { setExportOpen(false); x.run() }}
                    >
                      {x.label}
                      <span style={{ color: T.text3, marginLeft: 8, fontSize: 11 }}>{x.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: T.text3, textAlign: 'right' }}>
            Order data: {loading ? '…' : relTime(ordersAsOf)}<br />
            Workshop data: {workshopAsOf ? relTime(workshopAsOf) : 'not scraped yet'}
          </div>
        </div>

        {note && (
          <div style={{ padding: '8px 16px', background: 'rgba(79,142,247,0.1)', borderBottom: `1px solid ${T.border}`, color: T.text2, fontSize: 12, flexShrink: 0 }}>
            {note}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px' }}>
          {loading && !html && <div style={{ color: T.text3 }}>Loading live sales recap…</div>}
          {err && (
            <div style={{ maxWidth: 640, background: 'rgba(240,78,78,0.1)', border: '1px solid rgba(240,78,78,0.2)', borderRadius: 10, padding: 16, color: T.red }}>
              <div style={{ marginBottom: 10 }}>Couldn’t load report: {err}</div>
              <button onClick={refresh} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${T.blue}`, background: T.blue, color: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
            </div>
          )}
          {html && (
            <div style={{ maxWidth: 860, margin: '0 auto', opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
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

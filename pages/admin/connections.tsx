// pages/admin/connections.tsx
// Status page — single-pane view of every external integration's health.
//
// What Morgan/Matt see:
//   - Header summary: counts of green/yellow/red/unknown plus "last check X ago"
//   - One section per category (accounting, workshop, comms, crm, phone, infra)
//   - Dense table per section: status pill | name | last check | last error | actions
//   - Auto-refresh every 30 seconds
//
// Reads from /api/admin/connections. The data is populated by a separate
// cron worker (next file we ship) that pings each integration on its own
// schedule and updates the integration_health table.

import { useEffect, useState } from 'react'
import Head from 'next/head'

// ─── Types ──────────────────────────────────────────────────────────────
interface Integration {
  name: string
  display_name: string
  category: string
  status: 'green' | 'yellow' | 'red' | 'unknown'
  last_check_at: string | null
  last_success_at: string | null
  last_error: string | null
  metadata: Record<string, any> | null
  fix_url: string | null
  runbook_section: string | null
  check_interval_min: number
  updated_at: string
}

interface ApiResponse {
  connections: Integration[]
  byCategory: Record<string, Integration[]>
  summary: { green: number; yellow: number; red: number; unknown: number }
  mostRecentCheck: string | null
  generated_at: string
}

// ─── Constants ──────────────────────────────────────────────────────────
const CATEGORY_ORDER = ['accounting', 'workshop', 'comms', 'crm', 'phone', 'infra'] as const

const CATEGORY_LABELS: Record<string, string> = {
  accounting: 'Accounting',
  workshop:   'Workshop',
  comms:      'Communications',
  crm:        'CRM',
  phone:      'Phone Analytics',
  infra:      'Infrastructure',
}

// ─── Helpers ────────────────────────────────────────────────────────────
function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0)         return 'in the future'
  if (ms < 60_000)    return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function StatusPill({ status }: { status: Integration['status'] }) {
  const styles: Record<Integration['status'], string> = {
    green:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    yellow:  'bg-amber-500/15 text-amber-300 border-amber-500/40',
    red:     'bg-rose-500/15 text-rose-300 border-rose-500/40',
    unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/40',
  }
  const labels: Record<Integration['status'], string> = {
    green: 'OK', yellow: 'WARN', red: 'DOWN', unknown: 'UNKNOWN',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider border ${styles[status]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${
        status === 'green'  ? 'bg-emerald-400' :
        status === 'yellow' ? 'bg-amber-400'   :
        status === 'red'    ? 'bg-rose-400'    :
                              'bg-zinc-500'
      }`} />
      {labels[status]}
    </span>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────
export default function ConnectionsPage() {
  const [data, setData]       = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [, tick]              = useState(0)  // forces relativeTime re-render every 10s

  async function fetchData() {
    try {
      const res = await fetch('/api/admin/connections', { credentials: 'same-origin' })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }
      const json: ApiResponse = await res.json()
      setData(json)
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // Auto-refresh data every 30s, and re-render relative-times every 10s
    const dataInt = setInterval(fetchData, 30_000)
    const tickInt = setInterval(() => tick(t => t + 1), 10_000)
    return () => { clearInterval(dataInt); clearInterval(tickInt) }
  }, [])

  return (
    <>
      <Head><title>Connections — JA Portal</title></Head>
      <div className="min-h-screen bg-[#0d0f12] text-[#e8eaf0]">
        <div className="mx-auto max-w-6xl px-6 py-8">

          {/* Header */}
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
              <p className="mt-1 text-sm text-zinc-400">
                Live status of every external integration the portal depends on.
              </p>
            </div>
            <button
              onClick={fetchData}
              className="rounded border border-zinc-700 bg-zinc-800/40 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 hover:border-zinc-600 transition"
            >
              Refresh
            </button>
          </div>

          {/* Summary banner */}
          {data && (
            <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <SummaryStat count={data.summary.green}   label="OK"      color="text-emerald-300" />
                <SummaryStat count={data.summary.yellow}  label="Warn"    color="text-amber-300" />
                <SummaryStat count={data.summary.red}     label="Down"    color="text-rose-300" />
                <SummaryStat count={data.summary.unknown} label="Unknown" color="text-zinc-400" />
                <div className="ml-auto text-xs text-zinc-500">
                  Most recent check: <span className="text-zinc-300">{relativeTime(data.mostRecentCheck)}</span>
                  <span className="mx-2">·</span>
                  Updated: <span className="text-zinc-300">{relativeTime(data.generated_at)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Errors */}
          {error && (
            <div className="mb-6 rounded-lg border border-rose-500/40 bg-rose-950/30 p-4 text-sm text-rose-300">
              <strong>Couldn't load connections:</strong> {error}
            </div>
          )}

          {/* Loading state */}
          {loading && !data && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center text-zinc-500">
              Loading…
            </div>
          )}

          {/* Categories */}
          {data && CATEGORY_ORDER.map(cat => {
            const rows = data.byCategory[cat] || []
            if (rows.length === 0) return null
            return <CategorySection key={cat} category={cat} rows={rows} />
          })}

          {/* Catch any rows in unexpected categories not in CATEGORY_ORDER */}
          {data && Object.keys(data.byCategory).filter(c => !CATEGORY_ORDER.includes(c as any)).map(cat =>
            <CategorySection key={cat} category={cat} rows={data.byCategory[cat]} />
          )}

        </div>
      </div>
    </>
  )
}

function SummaryStat({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-2xl font-semibold tabular-nums ${color}`}>{count}</span>
      <span className="text-xs uppercase tracking-wider text-zinc-500">{label}</span>
    </div>
  )
}

function CategorySection({ category, rows }: { category: string; rows: Integration[] }) {
  const label = CATEGORY_LABELS[category] || category
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
        {label}
        <span className="ml-2 text-zinc-700">·</span>
        <span className="ml-2 text-zinc-600">{rows.length}</span>
      </h2>

      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/30">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wider text-zinc-500">
              <th className="px-4 py-2.5 w-24">Status</th>
              <th className="px-4 py-2.5">Integration</th>
              <th className="px-4 py-2.5 w-32">Last check</th>
              <th className="px-4 py-2.5 w-32">Last success</th>
              <th className="px-4 py-2.5">Last error</th>
              <th className="px-4 py-2.5 w-20 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.name}
                className={`${i > 0 ? 'border-t border-zinc-800/60' : ''} hover:bg-zinc-800/30 transition`}
              >
                <td className="px-4 py-2.5">
                  <StatusPill status={row.status} />
                </td>
                <td className="px-4 py-2.5">
                  <div className="font-medium text-zinc-200">{row.display_name}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-zinc-600">{row.name}</div>
                </td>
                <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                  {relativeTime(row.last_check_at)}
                </td>
                <td className="px-4 py-2.5 text-zinc-400 tabular-nums">
                  {relativeTime(row.last_success_at)}
                </td>
                <td className="px-4 py-2.5 text-zinc-400">
                  {row.last_error
                    ? <span className="text-rose-300/90 line-clamp-2">{row.last_error}</span>
                    : <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {row.fix_url ? (
                    <a
                      href={row.fix_url}
                      target={row.fix_url.startsWith('http') ? '_blank' : undefined}
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 hover:underline text-xs"
                    >
                      Fix →
                    </a>
                  ) : (
                    <span className="text-zinc-700 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

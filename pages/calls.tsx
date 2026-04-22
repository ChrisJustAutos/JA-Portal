// pages/calls.tsx
// Phone call analytics page. Lists all inbound/outbound calls from FreePBX CDR
// (pushed to Supabase by ja-cdr-sync agent). Per-agent stats, filtering, drill-down.
// Phase 1 of 3 — Phase 2 adds transcription, Phase 3 adds AI coaching analysis.

import { useEffect, useState, useCallback, useMemo } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../lib/PortalSidebar'
import { requirePageAuth } from '../lib/authServer'

interface PortalUserSSR { id: string; email: string; displayName: string | null; role: 'admin'|'manager'|'sales'|'accountant'|'viewer' }

interface CallRow {
  id: string
  linkedid: string
  call_date: string
  direction: 'inbound' | 'outbound'
  external_number: string | null
  caller_name: string | null
  agent_ext: string | null
  agent_name: string | null
  duration_seconds: number
  billsec_seconds: number
  disposition: string
  call_type: string | null
  has_recording: boolean
  transcript_status: string | null
  sales_score: number | null
}

interface AgentStats {
  extension: string
  display_name: string
  role: string | null
  today_total: number
  today_answered_inbound: number
  today_outbound: number
  today_talk_seconds: number
  week_talk_seconds: number
}

interface StatsPayload {
  periodLabel: string
  today: {
    total: number; inbound: number; outbound: number; answered: number
    missed_inbound: number; talk_seconds: number; avg_call_seconds: number; answer_rate: number
  }
  week: { total: number; talk_seconds: number }
  agents: AgentStats[]
  sync: { last_synced_at: string | null; last_error: string | null; records_synced_total: number }
}

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b',
  amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa',
  accent: '#4f8ef7',
}

// ── Date helpers ───────────────────────────────────────────────────────────

function toYmd(d: Date): string {
  // Returns YYYY-MM-DD in Brisbane local time (UTC+10, no DST)
  const brisbane = new Date(d.getTime() + 10 * 3600 * 1000)
  return brisbane.toISOString().slice(0, 10)
}

function ymdToday(): string { return toYmd(new Date()) }

function ymdDaysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n)
  return toYmd(d)
}

function ymdStartOfMonth(): string {
  const d = new Date(); d.setDate(1)
  return toYmd(d)
}

function ymdStartOfFY(year: number): string {
  // Australian FY starts 1 July. FY2026 = 1 July 2025 → 30 June 2026.
  return `${year - 1}-07-01`
}

function ymdEndOfFY(year: number): string {
  return `${year}-06-30`
}

function currentFY(): number {
  const now = new Date()
  const m = now.getMonth() + 1  // 1-12
  return m >= 7 ? now.getFullYear() + 1 : now.getFullYear()
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function formatDurationLong(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatPhone(num: string | null): string {
  if (!num) return ''
  if (num === 'anonymous') return 'Anonymous'
  const clean = num.replace(/\D/g, '')
  if (clean.length >= 10 && clean.startsWith('04')) {
    return `${clean.slice(0, 4)} ${clean.slice(4, 7)} ${clean.slice(7)}`
  }
  if (clean.length === 10 && clean.startsWith('0')) {
    return `(${clean.slice(0, 2)}) ${clean.slice(2, 6)} ${clean.slice(6)}`
  }
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`
  return num
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
  const dDate = new Date(d); dDate.setHours(0, 0, 0, 0)
  const timeStr = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (dDate.getTime() === today.getTime()) return `Today ${timeStr}`
  if (dDate.getTime() === yesterday.getTime()) return `Yesterday ${timeStr}`
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' + timeStr
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  const ago = Math.floor((Date.now() - d.getTime()) / 1000)
  if (ago < 60) return `${ago}s ago`
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`
  return d.toLocaleString('en-AU')
}

// ── Small presentational components ────────────────────────────────────────

function StatCard({ label, value, sublabel, accent }: { label: string; value: string | number; sublabel?: string; accent?: string }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 300, fontFamily: "'DM Mono', monospace", color: accent || T.text, lineHeight: 1 }}>{value}</div>
      {sublabel && <div style={{ fontSize: 11, color: T.text3, marginTop: 6 }}>{sublabel}</div>}
    </div>
  )
}

function DirectionBadge({ direction, disposition }: { direction: string; disposition: string }) {
  const missed = disposition !== 'ANSWERED'
  const icon = missed ? '✕' : (direction === 'inbound' ? '↓' : '↑')
  const bg = missed ? 'rgba(240,78,78,0.12)' : (direction === 'inbound' ? 'rgba(52,199,123,0.12)' : 'rgba(79,142,247,0.12)')
  const color = missed ? T.red : (direction === 'inbound' ? T.green : T.blue)
  const border = missed ? 'rgba(240,78,78,0.25)' : (direction === 'inbound' ? 'rgba(52,199,123,0.25)' : 'rgba(79,142,247,0.25)')
  return (
    <div style={{ width: 26, height: 26, borderRadius: 5, background: bg, border: `1px solid ${border}`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
      {icon}
    </div>
  )
}

// ── Main page component ────────────────────────────────────────────────────

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export default function CallsPage({ user }: { user: PortalUserSSR }) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [calls, setCalls] = useState<CallRow[]>([])
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [selectedCall, setSelectedCall] = useState<CallRow | null>(null)

  // Date range state — explicit YYYY-MM-DD strings (Brisbane time)
  const [startDate, setStartDate] = useState<string>(ymdToday())
  const [endDate, setEndDate] = useState<string>(ymdToday())
  const [activePreset, setActivePreset] = useState<Preset>('today')

  // Other filters
  const [filterExt, setFilterExt] = useState<string>('all')
  const [filterDir, setFilterDir] = useState<string>('all')
  const [filterDisp, setFilterDisp] = useState<string>('all')
  const [search, setSearch] = useState<string>('')
  const [searchDebounced, setSearchDebounced] = useState<string>('')

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  // Preset → date range
  function applyPreset(preset: Preset) {
    setActivePreset(preset)
    if (preset === 'today') {
      setStartDate(ymdToday()); setEndDate(ymdToday())
    } else if (preset === 'yesterday') {
      const y = ymdDaysAgo(1); setStartDate(y); setEndDate(y)
    } else if (preset === 'week') {
      setStartDate(ymdDaysAgo(6)); setEndDate(ymdToday())
    } else if (preset === 'month') {
      setStartDate(ymdStartOfMonth()); setEndDate(ymdToday())
    }
    // 'custom' — don't change dates, user is editing them manually
  }

  // When user types in a date field, switch preset label to "custom"
  function handleStartChange(v: string) {
    setStartDate(v); setActivePreset('custom')
  }
  function handleEndChange(v: string) {
    setEndDate(v); setActivePreset('custom')
  }

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('startDate', startDate)
      params.set('endDate', endDate)
      if (filterExt !== 'all') params.set('extension', filterExt)
      if (filterDir !== 'all') params.set('direction', filterDir)
      if (filterDisp !== 'all') params.set('disposition', filterDisp)
      if (searchDebounced) params.set('search', searchDebounced)

      const statsParams = new URLSearchParams()
      statsParams.set('startDate', startDate)
      statsParams.set('endDate', endDate)

      const [callsRes, statsRes] = await Promise.all([
        fetch(`/api/calls?${params.toString()}`),
        fetch(`/api/calls/stats?${statsParams.toString()}`),
      ])
      if (callsRes.status === 401 || statsRes.status === 401) { router.push('/login'); return }
      const callsData = await callsRes.json()
      const statsData = await statsRes.json()
      if (callsRes.ok) {
        setCalls(callsData.calls || [])
        setTruncated(!!callsData.truncated)
      }
      if (statsRes.ok) setStats(statsData)
      setLastRefresh(new Date())
    } catch (e) {
      console.error('Failed to load calls', e)
    } finally {
      setLoading(false); setRefreshing(false)
    }
  }, [router, startDate, endDate, filterExt, filterDir, filterDisp, searchDebounced])

  useEffect(() => { load(false) }, [load])

  // Auto-refresh every 60 seconds when viewing "today"
  useEffect(() => {
    if (activePreset !== 'today') return
    const timer = setInterval(() => load(true), 60_000)
    return () => clearInterval(timer)
  }, [load, activePreset])

  const maxWeekTalk = useMemo(() => {
    if (!stats?.agents) return 1
    return Math.max(...stats.agents.map(a => a.week_talk_seconds), 1)
  }, [stats])

  const filterExtName = filterExt !== 'all' ? stats?.agents.find(a => a.extension === filterExt)?.display_name : null
  const fy = currentFY()

  return (
    <>
      <Head><title>Phone Calls — Just Autos</title><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex,nofollow"/></Head>

      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', fontFamily: "'DM Sans',system-ui,sans-serif", color: T.text }}>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

        <PortalSidebar
          activeId="calls"
          lastRefresh={lastRefresh}
          onRefresh={() => load(true)}
          refreshing={refreshing}
          currentUserRole={user.role}
          currentUserVisibleTabs={(user as any).visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
          {/* Top bar with date controls (matches distributors.tsx style) */}
          <div style={{ height: 52, background: T.bg2, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 10, flexShrink: 0 }}>
            <div style={{ width: 26, height: 26, borderRadius: 6, background: T.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: '#fff' }}>JA</div>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Phone Calls</span>
            <div style={{ flex: 1 }}/>
            {!loading && stats && (
              <>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: stats.sync.last_error ? T.red : T.green, boxShadow: `0 0 6px ${stats.sync.last_error ? T.red : T.green}` }}/>
                <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4, background: stats.sync.last_error ? 'rgba(240,78,78,0.12)' : 'rgba(52,199,123,0.12)', color: stats.sync.last_error ? T.red : T.green, border: `1px solid ${stats.sync.last_error ? 'rgba(240,78,78,0.2)' : 'rgba(52,199,123,0.2)'}` }}>
                  {stats.sync.last_error ? 'Sync error' : `Synced ${formatSyncTime(stats.sync.last_synced_at)}`}
                </span>
                <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 8px', borderRadius: 4, background: 'rgba(79,142,247,0.12)', color: T.blue, border: '1px solid rgba(79,142,247,0.2)' }}>
                  {stats.sync.records_synced_total.toLocaleString('en-AU')} total
                </span>
              </>
            )}
            <div style={{ width: 1, height: 18, background: T.border }}/>
            {/* Preset buttons */}
            {([
              { id: 'today', label: 'Today' },
              { id: 'yesterday', label: 'Yesterday' },
              { id: 'week', label: '7d' },
              { id: 'month', label: 'MTD' },
            ] as { id: Preset; label: string }[]).map(p => (
              <button key={p.id} onClick={() => applyPreset(p.id)}
                style={{
                  padding: '3px 10px', borderRadius: 4, border: '1px solid',
                  fontSize: 11, fontFamily: 'monospace', fontWeight: 600, cursor: 'pointer',
                  background: activePreset === p.id ? T.accent : 'transparent',
                  color: activePreset === p.id ? '#fff' : T.text2,
                  borderColor: activePreset === p.id ? T.accent : T.border,
                }}>{p.label}</button>
            ))}
            <input type="date" value={startDate} max={endDate} onChange={e => handleStartChange(e.target.value)}
              style={{ padding: '3px 6px', borderRadius: 4, border: `1px solid ${activePreset === 'custom' ? T.accent : T.border}`, fontSize: 11, fontFamily: 'monospace', background: 'transparent', color: T.text2, outline: 'none', colorScheme: 'dark' }}/>
            <span style={{ fontSize: 11, color: T.text3 }}>→</span>
            <input type="date" value={endDate} min={startDate} max={ymdToday()} onChange={e => handleEndChange(e.target.value)}
              style={{ padding: '3px 6px', borderRadius: 4, border: `1px solid ${activePreset === 'custom' ? T.accent : T.border}`, fontSize: 11, fontFamily: 'monospace', background: 'transparent', color: T.text2, outline: 'none', colorScheme: 'dark' }}/>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
            {loading && !stats ? (
              <div style={{ textAlign: 'center', padding: 80, color: T.text3 }}>
                <div style={{ fontSize: 24, animation: 'spin 1s linear infinite', marginBottom: 12 }}>⟳</div>
                <div style={{ fontSize: 12 }}>Loading call data…</div>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            ) : (
              <>
                {/* Stats row */}
                {stats && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                        {stats.periodLabel} {activePreset !== 'custom' && <span style={{ color: T.text2, marginLeft: 6 }}>({startDate === endDate ? startDate : `${startDate} → ${endDate}`})</span>}
                      </div>
                      <div style={{ fontSize: 11, color: T.text3, fontFamily: 'monospace' }}>
                        {new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
                      <StatCard label="Total Calls" value={stats.today.total} />
                      <StatCard label="Inbound" value={stats.today.inbound} sublabel={stats.today.total ? `${Math.round(stats.today.inbound / stats.today.total * 100)}% of period` : undefined} accent={T.green} />
                      <StatCard label="Outbound" value={stats.today.outbound} sublabel={stats.today.total ? `${Math.round(stats.today.outbound / stats.today.total * 100)}% of period` : undefined} accent={T.blue} />
                      <StatCard label="Answer Rate" value={`${stats.today.answer_rate}%`} sublabel={`${stats.today.missed_inbound} missed inbound`} />
                      <StatCard label="Total Talk Time" value={formatDurationLong(stats.today.talk_seconds)} sublabel="across all agents" />
                      <StatCard label="Avg Call Length" value={formatDuration(stats.today.avg_call_seconds)} sublabel="when answered" />
                    </div>
                  </div>
                )}

                {/* Two-column layout */}
                <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
                  {/* Left: per-agent + splits */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {stats && (
                      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                          <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Per Agent</div>
                          <div style={{ fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Bar = last 7 days</div>
                        </div>
                        <div>
                          {stats.agents.length === 0 ? (
                            <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: T.text3 }}>No agent activity yet</div>
                          ) : stats.agents.map(a => {
                            const isActive = filterExt === a.extension
                            const pct = Math.round((a.week_talk_seconds / maxWeekTalk) * 100)
                            return (
                              <button
                                key={a.extension}
                                onClick={() => setFilterExt(isActive ? 'all' : a.extension)}
                                style={{
                                  display: 'block', width: '100%', padding: '12px 16px',
                                  border: 'none', borderBottom: `1px solid ${T.border}`,
                                  background: isActive ? 'rgba(79,142,247,0.08)' : 'transparent',
                                  color: T.text, textAlign: 'left', cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.display_name}</div>
                                  <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{a.extension}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: T.text2, fontFamily: 'monospace', marginBottom: 6 }}>
                                  <span>Period: {a.today_total}</span>
                                  <span style={{ marginLeft: 'auto', color: T.text, fontWeight: 500 }}>{formatDurationLong(a.week_talk_seconds)}</span>
                                </div>
                                <div style={{ height: 3, background: T.bg4, borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', background: T.blue, width: `${pct}%`, transition: 'width 0.3s' }}/>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {stats && (
                      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, padding: 16 }}>
                        <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>Period Split</div>
                        {[
                          { label: 'Inbound', value: stats.today.inbound, color: T.green },
                          { label: 'Outbound', value: stats.today.outbound, color: T.blue },
                          { label: 'Missed Inbound', value: stats.today.missed_inbound, color: T.red },
                        ].map(row => (
                          <div key={row.label} style={{ marginBottom: 10 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ fontSize: 11, color: T.text2 }}>{row.label}</span>
                              <span style={{ fontSize: 11, fontFamily: 'monospace', color: T.text }}>{row.value}</span>
                            </div>
                            <div style={{ height: 4, background: T.bg4, borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ height: '100%', background: row.color, width: `${stats.today.total > 0 ? (row.value / stats.today.total) * 100 : 0}%`, transition: 'width 0.3s' }}/>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: call list */}
                  <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {/* Filter bar */}
                    <div style={{ padding: 12, borderBottom: `1px solid ${T.border}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input
                        type="text"
                        placeholder="Search number, name, or agent…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{
                          flex: 1, minWidth: 200, padding: '7px 10px',
                          background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5,
                          color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
                        }}
                      />
                      <select value={filterDir} onChange={e => setFilterDir(e.target.value)}
                        style={{ padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer' }}>
                        <option value="all">All directions</option>
                        <option value="inbound">Inbound</option>
                        <option value="outbound">Outbound</option>
                      </select>
                      <select value={filterDisp} onChange={e => setFilterDisp(e.target.value)}
                        style={{ padding: '6px 8px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 5, color: T.text, fontSize: 11, fontFamily: 'inherit', cursor: 'pointer' }}>
                        <option value="all">All statuses</option>
                        <option value="answered">Answered</option>
                        <option value="missed">Missed</option>
                      </select>
                      {filterExt !== 'all' && filterExtName && (
                        <button onClick={() => setFilterExt('all')}
                          style={{ padding: '5px 10px', background: T.blue, border: 'none', borderRadius: 5, color: '#fff', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {filterExtName} <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
                        </button>
                      )}
                    </div>

                    {/* Headers */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '34px 1fr 140px 30px 70px 70px 100px',
                      gap: 8, padding: '8px 14px',
                      borderBottom: `1px solid ${T.border}`, background: T.bg3,
                      fontSize: 9, color: T.text3, fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.1em',
                    }}>
                      <div/>
                      <div>Number / Caller</div>
                      <div>Agent</div>
                      <div style={{ textAlign: 'center' }}>Rec</div>
                      <div style={{ textAlign: 'right' }}>Duration</div>
                      <div style={{ textAlign: 'right' }}>Status</div>
                      <div style={{ textAlign: 'right' }}>When</div>
                    </div>

                    {/* Rows */}
                    <div style={{ flex: 1, overflow: 'auto', maxHeight: 'calc(100vh - 340px)' }}>
                      {calls.length === 0 ? (
                        <div style={{ padding: 60, textAlign: 'center', fontSize: 12, color: T.text3 }}>
                          No calls match the current filters
                        </div>
                      ) : calls.map(c => (
                        <div
                          key={c.id}
                          onClick={() => setSelectedCall(c)}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '34px 1fr 140px 30px 70px 70px 100px',
                            gap: 8, padding: '10px 14px',
                            borderBottom: `1px solid ${T.border}`,
                            cursor: 'pointer',
                            alignItems: 'center',
                            transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)' }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                          <DirectionBadge direction={c.direction} disposition={c.disposition} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {c.caller_name || formatPhone(c.external_number)}
                            </div>
                            {c.caller_name && (
                              <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>{formatPhone(c.external_number)}</div>
                            )}
                          </div>
                          <div>
                            {c.agent_name ? (
                              <>
                                <div style={{ fontSize: 11, color: T.text }}>{c.agent_name}</div>
                                <div style={{ fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>Ext {c.agent_ext}</div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: T.text3, fontStyle: 'italic' }}>Unanswered</div>
                            )}
                          </div>
                          <div style={{ textAlign: 'center', fontSize: 11, color: c.has_recording ? T.text2 : T.text3 }}>
                            {c.has_recording ? '●' : '—'}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 11, fontFamily: 'monospace', color: T.text2 }}>
                            {formatDuration(c.billsec_seconds || c.duration_seconds)}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 10, color: c.disposition === 'ANSWERED' ? T.text2 : T.red, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                            {c.disposition === 'ANSWERED' ? 'Answered' : 'Missed'}
                          </div>
                          <div style={{ textAlign: 'right', fontSize: 10, color: T.text3, fontFamily: 'monospace' }}>
                            {formatRelative(c.call_date)}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ padding: '8px 14px', borderTop: `1px solid ${T.border}`, background: T.bg3, display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.text3 }}>
                      <span style={{ fontFamily: 'monospace' }}>{calls.length} calls shown{truncated ? ' (row limit hit — narrow filters for more)' : ''}</span>
                      <span>Click any row for details</span>
                    </div>
                  </div>
                </div>

                {/* Phase roadmap note */}
                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', gap: 12, fontSize: 9, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                  <span style={{ color: T.text2, fontWeight: 600 }}>Phase 1 · Call Logging</span>
                  <span>·</span>
                  <span>Phase 2 · Transcription</span>
                  <span>·</span>
                  <span>Phase 3 · AI Coaching</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {selectedCall && (
        <div
          onClick={() => setSelectedCall(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'flex-end' }}>
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 640, height: '100vh', background: T.bg2, borderLeft: `1px solid ${T.border2}`, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '16px 24px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, background: T.bg2 }}>
              <div>
                <div style={{ fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Call Detail</div>
                <div style={{ fontSize: 11, color: T.text2, fontFamily: 'monospace' }}>{selectedCall.linkedid}</div>
              </div>
              <button onClick={() => setSelectedCall(null)}
                style={{ width: 32, height: 32, borderRadius: 6, background: T.bg3, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit' }}>×</button>
            </div>

            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <DirectionBadge direction={selectedCall.direction} disposition={selectedCall.disposition} />
                <div>
                  <div style={{ fontSize: 20, fontWeight: 300, color: T.text }}>
                    {selectedCall.caller_name || formatPhone(selectedCall.external_number)}
                  </div>
                  {selectedCall.caller_name && (
                    <div style={{ fontSize: 12, color: T.text3, fontFamily: 'monospace' }}>{formatPhone(selectedCall.external_number)}</div>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: T.border, border: `1px solid ${T.border}`, borderRadius: 6, overflow: 'hidden' }}>
                {[
                  ['Direction', selectedCall.direction.charAt(0).toUpperCase() + selectedCall.direction.slice(1)],
                  ['Status', selectedCall.disposition === 'ANSWERED' ? 'Answered' : 'Missed'],
                  ['Agent', selectedCall.agent_name ? `${selectedCall.agent_name} (Ext ${selectedCall.agent_ext})` : 'Nobody answered'],
                  ['Talk Time', formatDuration(selectedCall.billsec_seconds || selectedCall.duration_seconds)],
                  ['When', new Date(selectedCall.call_date).toLocaleString('en-AU')],
                  ['Recording', selectedCall.has_recording ? 'Available on FreePBX' : 'None'],
                ].map(([label, value]) => (
                  <div key={label as string} style={{ background: T.bg2, padding: '12px 14px' }}>
                    <div style={{ fontSize: 9, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 12, color: T.text }}>{value}</div>
                  </div>
                ))}
              </div>

              {[
                ['Phase 2 — Transcript', 'Full conversation transcript with speaker labels will appear here once Deepgram integration is live.'],
                ['Phase 3 — AI Coaching Analysis', 'Claude-generated sales score, objections raised, discovery quality, outcome classification, and specific coaching feedback for this call.'],
                ['MYOB Customer Context', `If ${formatPhone(selectedCall.external_number)} matches a customer card in MYOB, their recent orders, outstanding quotes, and payment history will load here via CData.`],
              ].map(([title, body]) => (
                <div key={title} style={{ border: `1px dashed ${T.border2}`, borderRadius: 6, padding: 16, background: T.bg3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{title}</div>
                    <div style={{ fontSize: 9, color: T.amber, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Coming soon</div>
                  </div>
                  <div style={{ fontSize: 12, color: T.text3, fontStyle: 'italic', lineHeight: 1.5 }}>{body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'view:calls')
}

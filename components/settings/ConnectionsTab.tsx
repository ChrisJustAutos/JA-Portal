// components/settings/ConnectionsTab.tsx
// Connections / Health status tab inside Settings. Reads from
// /api/admin/connections and renders one table per integration category.
//
// Auto-refreshes data every 30s. Re-renders relative timestamps every 10s
// so "5m ago" stays accurate without re-fetching.
//
// Style: matches the rest of the Settings UI — inline styles using the
// shared T theme object, no Tailwind. Card-and-table layout per category.

import { useEffect, useState } from 'react'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

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

function statusColor(status: Integration['status']): { dot: string; bg: string; text: string; border: string; label: string } {
  switch (status) {
    case 'green':   return { dot: T.green,  bg: `${T.green}15`,  text: T.green,  border: `${T.green}40`,  label: 'OK' }
    case 'yellow':  return { dot: T.amber,  bg: `${T.amber}15`,  text: T.amber,  border: `${T.amber}40`,  label: 'WARN' }
    case 'red':     return { dot: T.red,    bg: `${T.red}15`,    text: T.red,    border: `${T.red}40`,    label: 'DOWN' }
    case 'unknown': return { dot: T.text3,  bg: `${T.text3}15`,  text: T.text3,  border: `${T.text3}40`,  label: 'UNKNOWN' }
  }
}

function StatusPill({ status }: { status: Integration['status'] }) {
  const c = statusColor(status)
  return (
    <span style={{
      display:'inline-flex',alignItems:'center',gap:6,
      padding:'2px 8px',borderRadius:3,
      background: c.bg,
      border: `1px solid ${c.border}`,
      color: c.text,
      fontSize:10,fontWeight:600,
      textTransform:'uppercase',letterSpacing:'0.05em',
      whiteSpace:'nowrap',
    }}>
      <span style={{
        display:'inline-block',width:6,height:6,borderRadius:'50%',
        background: c.dot,
      }}/>
      {c.label}
    </span>
  )
}

function SummaryStat({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div style={{display:'flex',alignItems:'baseline',gap:6}}>
      <span style={{fontSize:22,fontWeight:600,color,fontVariantNumeric:'tabular-nums'}}>{count}</span>
      <span style={{fontSize:10,color:T.text3,textTransform:'uppercase',letterSpacing:'0.05em'}}>{label}</span>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────
export default function ConnectionsTab() {
  const [data, setData]       = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [, tick]              = useState(0)

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
    const dataInt = setInterval(fetchData, 30_000)
    const tickInt = setInterval(() => tick(t => t + 1), 10_000)
    return () => { clearInterval(dataInt); clearInterval(tickInt) }
  }, [])

  return (
    <div style={{display:'flex',flexDirection:'column',gap:16}}>

      {/* Summary banner */}
      {data && (
        <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:'14px 18px'}}>
          <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:24}}>
            <SummaryStat count={data.summary.green}   label="OK"      color={T.green}/>
            <SummaryStat count={data.summary.yellow}  label="Warn"    color={T.amber}/>
            <SummaryStat count={data.summary.red}     label="Down"    color={T.red}/>
            <SummaryStat count={data.summary.unknown} label="Unknown" color={T.text3}/>
            <div style={{marginLeft:'auto',display:'flex',gap:18,fontSize:11,color:T.text3}}>
              <div>
                Most recent check:{' '}
                <span style={{color:T.text2,fontFamily:'monospace'}}>{relativeTime(data.mostRecentCheck)}</span>
              </div>
              <button onClick={fetchData}
                style={{padding:'4px 12px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,padding:10,color:T.red,fontSize:12}}>
          <strong>Couldn't load connections:</strong> {error}
        </div>
      )}

      {/* Loading state (only while we have nothing) */}
      {loading && !data && (
        <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:30,textAlign:'center',color:T.text3,fontSize:12}}>
          Loading…
        </div>
      )}

      {/* Categories */}
      {data && CATEGORY_ORDER.map(cat => {
        const rows = data.byCategory[cat] || []
        if (rows.length === 0) return null
        return <CategorySection key={cat} category={cat} rows={rows} />
      })}

      {/* Catch any unexpected categories not in CATEGORY_ORDER */}
      {data && Object.keys(data.byCategory)
        .filter(c => !CATEGORY_ORDER.includes(c as any))
        .map(cat => <CategorySection key={cat} category={cat} rows={data.byCategory[cat]} />)
      }

    </div>
  )
}

// ─── Per-category table section ────────────────────────────────────────
function CategorySection({ category, rows }: { category: string; rows: Integration[] }) {
  const label = CATEGORY_LABELS[category] || category
  return (
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${T.border2}`,display:'flex',alignItems:'baseline',gap:10}}>
        <div style={{fontSize:11,fontWeight:600,color:T.text2,textTransform:'uppercase',letterSpacing:'0.08em'}}>{label}</div>
        <div style={{fontSize:11,color:T.text3}}>· {rows.length}</div>
      </div>
      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead>
            <tr style={{borderBottom:`1px solid ${T.border}`}}>
              <th style={thStyle(80)}>Status</th>
              <th style={thStyle()}>Integration</th>
              <th style={thStyle(110)}>Last check</th>
              <th style={thStyle(110)}>Last success</th>
              <th style={thStyle()}>Last error</th>
              <th style={{...thStyle(60),textAlign:'right'}}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.name} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
                <td style={tdStyle()}><StatusPill status={row.status}/></td>
                <td style={tdStyle()}>
                  <div style={{fontSize:12,color:T.text,fontWeight:500}}>{row.display_name}</div>
                  <div style={{fontSize:10,color:T.text3,fontFamily:'monospace',marginTop:2}}>{row.name}</div>
                </td>
                <td style={{...tdStyle(),fontSize:11,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
                  {relativeTime(row.last_check_at)}
                </td>
                <td style={{...tdStyle(),fontSize:11,color:T.text3,fontFamily:'monospace',whiteSpace:'nowrap'}}>
                  {relativeTime(row.last_success_at)}
                </td>
                <td style={tdStyle()}>
                  {row.last_error ? (
                    <span style={{
                      fontSize:11,color:T.red,
                      display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',
                    }}>{row.last_error}</span>
                  ) : (
                    <span style={{color:T.text3,fontSize:11}}>—</span>
                  )}
                </td>
                <td style={{...tdStyle(),textAlign:'right',whiteSpace:'nowrap'}}>
                  {row.fix_url ? (() => {
                    const needsFix = row.status === 'red' || row.status === 'yellow'
                    return (
                      <a href={row.fix_url}
                         target={row.fix_url.startsWith('http') ? '_blank' : undefined}
                         rel="noopener noreferrer"
                         style={{
                           fontSize:11,
                           color: needsFix ? T.red : T.text2,
                           textDecoration:'none',
                           fontWeight: needsFix ? 600 : 400,
                         }}>
                        {needsFix ? 'Fix →' : 'Open →'}
                      </a>
                    )
                  })() : (
                    <span style={{fontSize:11,color:T.text3}}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function thStyle(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'9px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,
  }
}

function tdStyle(): React.CSSProperties {
  return { padding:'10px 12px',verticalAlign:'top' }
}

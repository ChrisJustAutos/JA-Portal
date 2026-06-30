// pages/agents/index.tsx
// The unified Agent inbox. Every monitoring agent posts findings here; staff
// triage them (Dismiss / Mark done). Phase 1 surfaces the Communications
// agent's findings; Accounts / Marketing / Ops slot in on the same screen.

import { useState, useEffect, useCallback } from 'react'
import Head from 'next/head'
import PortalTopBar from '../../lib/PortalTopBar'
import { requirePageAuth } from '../../lib/authServer'
import { UserRole } from '../../lib/permissions'
import { T } from '../../lib/ui/theme'
import { SkeletonRows } from '../../components/ui'

export async function getServerSideProps(ctx: any) {
  return requirePageAuth(ctx, 'view:agents')
}

interface SessionUser { id: string; email: string; role: UserRole; displayName: string | null; visibleTabs?: string[] | null }

interface Finding {
  id: string
  agent: string
  kind: string
  severity: 'info' | 'warn' | 'action'
  confidence: string | null
  title: string
  body: string | null
  href: string | null
  status: string
  created_at: string
}

const AGENT_LABEL: Record<string, string> = { comms: 'Communications', accounts: 'Accounts', marketing: 'Marketing', ops: 'Ops' }
const SEV_COLOR: Record<string, string> = { info: T.text3, warn: T.amber, action: T.red }

export default function AgentsInboxPage({ user }: { user: SessionUser }) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ status: statusFilter })
      if (agentFilter !== 'all') params.set('agent', agentFilter)
      const r = await fetch(`/api/agents/findings?${params.toString()}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Load failed')
      setFindings(d.findings || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [statusFilter, agentFilter])

  useEffect(() => { load() }, [load])

  async function decide(f: Finding, action: 'dismiss' | 'done') {
    if (busyId) return
    setBusyId(f.id)
    try {
      const r = await fetch(`/api/agents/findings/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed') }
      if (statusFilter === 'open') setFindings(prev => prev.filter(x => x.id !== f.id))
      else load()
    } catch (e: any) { setError(e.message) }
    finally { setBusyId(null) }
  }

  const agents = Array.from(new Set(findings.map(f => f.agent)))

  return (
    <>
      <Head><title>Agents — Just Autos</title></Head>
      <div style={{display:'flex', flexDirection:'column', minHeight:'100vh', background:T.bg, color:T.text, fontFamily:'system-ui, -apple-system, sans-serif'}}>
        <PortalTopBar activeId="agents" currentUserRole={user.role} currentUserVisibleTabs={user.visibleTabs} currentUserName={user.displayName} currentUserEmail={user.email}/>
        <main style={{flex:1, padding:'24px 32px 48px', overflow:'auto', maxWidth:1000, width:'100%', margin:'0 auto', boxSizing:'border-box'}}>

          <div style={{display:'flex', alignItems:'baseline', gap:12, marginBottom:6}}>
            <h1 style={{margin:0, fontSize:22, fontWeight:600}}>Agents</h1>
            <span style={{fontSize:11, color:T.text3}}>What the monitoring agents have flagged for your attention</span>
          </div>

          <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', margin:'16px 0'}}>
            {(['open','all'] as const).map(s => (
              <button key={s} onClick={() => setStatusFilter(s)}
                style={chip(statusFilter === s)}>{s === 'open' ? 'Open' : 'All'}</button>
            ))}
            <span style={{width:1, height:18, background:T.border2, margin:'0 4px'}}/>
            <button onClick={() => setAgentFilter('all')} style={chip(agentFilter === 'all')}>All agents</button>
            {['comms','accounts','marketing','ops'].filter(a => agents.includes(a) || a === 'comms').map(a => (
              <button key={a} onClick={() => setAgentFilter(a)} style={chip(agentFilter === a)}>{AGENT_LABEL[a] || a}</button>
            ))}
          </div>

          {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13, marginBottom:12}}>{error}</div>}

          {loading ? (
            <SkeletonRows rows={6}/>
          ) : findings.length === 0 ? (
            <div style={{padding:'40px 20px', textAlign:'center', color:T.text3, fontSize:13, background:T.bg2, borderRadius:10, border:`1px dashed ${T.border2}`}}>
              {statusFilter === 'open' ? '✓ Nothing needs your attention.' : 'No findings.'}
            </div>
          ) : (
            <div style={{display:'flex', flexDirection:'column', gap:10}}>
              {findings.map(f => (
                <div key={f.id} style={{
                  background:T.bg2, border:`1px solid ${T.border}`, borderLeft:`3px solid ${SEV_COLOR[f.severity] || T.text3}`,
                  borderRadius:10, padding:'12px 14px', opacity: busyId === f.id ? 0.5 : 1,
                }}>
                  <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap'}}>
                    <span style={{fontSize:10, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em', color:T.text3, background:T.bg3, padding:'2px 7px', borderRadius:4}}>{AGENT_LABEL[f.agent] || f.agent}</span>
                    <span style={{fontSize:14, fontWeight:600, color:T.text}}>{f.title}</span>
                    {f.status !== 'new' && <span style={{fontSize:10, color:T.text3}}>· {f.status}</span>}
                    <span style={{marginLeft:'auto', fontSize:11, color:T.text3}}>{fmtRel(f.created_at)}</span>
                  </div>
                  {f.body && <div style={{fontSize:12.5, color:T.text2, whiteSpace:'pre-wrap', lineHeight:1.5, marginBottom:8}}>{f.body}</div>}
                  <div style={{display:'flex', gap:8, alignItems:'center'}}>
                    {f.href && <a href={f.href} style={{fontSize:12, color:T.blue, textDecoration:'none'}}>Open ↗</a>}
                    <span style={{flex:1}}/>
                    <button onClick={() => decide(f, 'dismiss')} disabled={!!busyId} style={btn(T.text3)}>Dismiss</button>
                    <button onClick={() => decide(f, 'done')} disabled={!!busyId} style={btn(T.green)}>Mark done</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </>
  )
}

function chip(on: boolean): React.CSSProperties {
  return { padding:'5px 11px', borderRadius:7, fontSize:12, fontFamily:'inherit', cursor:'pointer',
    background: on ? T.blue : 'transparent', color: on ? '#fff' : T.text2, border:`1px solid ${on ? T.blue : T.border2}` }
}
function btn(color: string): React.CSSProperties {
  return { padding:'4px 12px', borderRadius:6, fontSize:12, fontFamily:'inherit', fontWeight:600, cursor:'pointer',
    background:'transparent', color, border:`1px solid ${color}55` }
}
function fmtRel(iso: string): string {
  const t = new Date(iso).getTime(); if (!isFinite(t)) return ''
  const m = Math.floor((Date.now() - t) / 60000)
  if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

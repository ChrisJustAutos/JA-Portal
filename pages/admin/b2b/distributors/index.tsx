// pages/admin/b2b/distributors/index.tsx
//
// Distributors list page. Click a row to open the detail page.
// "Add distributor" opens a drawer with live MYOB customer typeahead —
// pick a customer card, review pre-filled fields, save → land on detail page.

import { useEffect, useState, useMemo } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../../../lib/PortalSidebar'
import { requirePageAuth } from '../../../../lib/authServer'
import type { UserRole } from '../../../../lib/permissions'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
}

interface Props {
  user: {
    id: string
    email: string
    displayName: string | null
    role: UserRole
    visibleTabs: string[] | null
  }
}

interface Distributor {
  id: string
  display_name: string
  abn: string | null
  myob_primary_customer_uid: string
  myob_primary_customer_display_id: string | null
  myob_linked_customer_uids: string[]
  dist_group_id: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  is_active: boolean
  active_user_count: number
  created_at: string
}

interface MyobCustomer {
  uid: string
  display_id: string
  name: string
  is_individual: boolean
  is_active: boolean
}

export default function DistributorsListPage({ user }: Props) {
  const router = useRouter()
  const [items, setItems] = useState<Distributor[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/b2b/admin/distributors', { credentials: 'same-origin' })
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`)
      const j = await r.json()
      setItems(j.items || [])
      setError(null)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(i =>
      i.display_name.toLowerCase().includes(q) ||
      (i.myob_primary_customer_display_id || '').toLowerCase().includes(q) ||
      (i.primary_contact_email || '').toLowerCase().includes(q),
    )
  }, [items, search])

  return (
    <>
      <Head><title>Distributors · B2B Portal · JA Portal</title></Head>
      <div style={{display:'flex',minHeight:'100vh',background:T.bg,color:T.text,fontFamily:'system-ui,-apple-system,sans-serif'}}>
        <PortalSidebar
          activeId="b2b"
          currentUserRole={user.role}
          currentUserVisibleTabs={user.visibleTabs}
          currentUserName={user.displayName}
          currentUserEmail={user.email}
        />
        <main style={{flex:1,padding:'28px 32px',maxWidth:1400}}>

          {/* Header */}
          <header style={{marginBottom:18,display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
            <div>
              <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:4}}>
                <a href="/admin/b2b" style={{color:T.text3,textDecoration:'none'}}>B2B Portal</a>
                {' / '}
                <span style={{color:T.text2}}>Distributors</span>
              </div>
              <h1 style={{fontSize:22,fontWeight:600,margin:0,letterSpacing:'-0.01em'}}>
                Distributors
              </h1>
            </div>
            <button onClick={() => setDrawerOpen(true)}
              style={{
                padding:'9px 16px',borderRadius:6,
                border:`1px solid ${T.blue}`,background:T.blue,color:'#fff',
                fontSize:13,fontWeight:500,cursor:'pointer',fontFamily:'inherit',
              }}>
              + Add distributor
            </button>
          </header>

          {/* Toolbar */}
          <div style={{
            display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',
            padding:'10px 12px',background:T.bg2,border:`1px solid ${T.border}`,
            borderRadius:8,marginBottom:14,
          }}>
            <input
              type="text"
              placeholder="Search by name, MYOB display ID or email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{
                flex:1,minWidth:200,
                background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
                borderRadius:5,padding:'7px 11px',fontSize:13,outline:'none',fontFamily:'inherit',
              }}
            />
            <button onClick={load} disabled={loading}
              style={{padding:'6px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:loading?'wait':'pointer',fontFamily:'inherit'}}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>

          {/* Errors */}
          {error && (
            <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:7,color:T.red,fontSize:12,marginBottom:10}}>
              {error}
            </div>
          )}

          {/* Table */}
          <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflow:'hidden'}}>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border2}`}}>
                    <th style={th()}>Distributor</th>
                    <th style={th(140)}>MYOB ID</th>
                    <th style={th(160)}>Linked customers</th>
                    <th style={th(220)}>Primary contact</th>
                    <th style={{...th(80),textAlign:'center'}}>Users</th>
                    <th style={{...th(80),textAlign:'center'}}>Active</th>
                    <th style={th(40)}></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && !loading && (
                    <tr><td colSpan={7} style={{padding:24,textAlign:'center',color:T.text3,fontSize:12}}>
                      {items.length === 0 ? 'No distributors yet — click "Add distributor" to create your first one.' : 'No matches.'}
                    </td></tr>
                  )}
                  {filtered.map((d, i) => (
                    <tr key={d.id}
                      onClick={() => router.push(`/admin/b2b/distributors/${d.id}`)}
                      style={{
                        borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                        cursor:'pointer',
                      }}>
                      <td style={td()}>
                        <div style={{color:T.text,fontWeight:500}}>{d.display_name}</div>
                        {d.abn && <div style={{fontSize:10,color:T.text3,fontFamily:'monospace',marginTop:2}}>ABN {d.abn}</div>}
                      </td>
                      <td style={{...td(),fontFamily:'monospace',fontSize:11,color:T.text2}}>
                        {d.myob_primary_customer_display_id || '—'}
                      </td>
                      <td style={{...td(),color:T.text3,fontSize:11}}>
                        {d.myob_linked_customer_uids?.length
                          ? `+${d.myob_linked_customer_uids.length} linked`
                          : '—'}
                      </td>
                      <td style={td()}>
                        <div style={{color:T.text2}}>{d.primary_contact_email || '—'}</div>
                        {d.primary_contact_phone && <div style={{fontSize:10,color:T.text3,marginTop:2}}>{d.primary_contact_phone}</div>}
                      </td>
                      <td style={{...td(),textAlign:'center',color:d.active_user_count > 0 ? T.text : T.text3,fontVariantNumeric:'tabular-nums'}}>
                        {d.active_user_count}
                      </td>
                      <td style={{...td(),textAlign:'center'}}>
                        <span style={{
                          display:'inline-block',padding:'2px 8px',borderRadius:8,fontSize:10,
                          background: d.is_active ? `${T.green}20` : `${T.text3}15`,
                          color: d.is_active ? T.green : T.text3,
                        }}>
                          {d.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{...td(),textAlign:'right'}}>
                        <span style={{color:T.text3}}>›</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </main>

        {drawerOpen && (
          <AddDistributorDrawer
            onClose={() => setDrawerOpen(false)}
            onCreated={(id) => {
              setDrawerOpen(false)
              router.push(`/admin/b2b/distributors/${id}`)
            }}
          />
        )}
      </div>
    </>
  )
}

// ─── Add drawer ─────────────────────────────────────────────────────────
function AddDistributorDrawer({
  onClose, onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [step, setStep] = useState<'search' | 'details'>('search')
  const [picked, setPicked] = useState<MyobCustomer | null>(null)

  // Form fields (pre-filled from MYOB customer once picked)
  const [displayName, setDisplayName] = useState('')
  const [abn, setAbn] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pickCustomer(c: MyobCustomer) {
    setPicked(c)
    setDisplayName(c.name)
    setStep('details')
  }

  async function save() {
    if (!picked) return
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/b2b/admin/distributors', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          display_name: displayName.trim(),
          myob_primary_customer_uid: picked.uid,
          myob_primary_customer_display_id: picked.display_id || null,
          abn: abn.trim() || null,
          primary_contact_email: contactEmail.trim() || null,
          primary_contact_phone: contactPhone.trim() || null,
          notes: notes.trim() || null,
        }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
      onCreated(j.item.id)
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:1000}}/>
      <div style={{
        position:'fixed',top:0,right:0,bottom:0,width:560,maxWidth:'94vw',
        background:T.bg2,borderLeft:`1px solid ${T.border2}`,
        display:'flex',flexDirection:'column',zIndex:1001,
        boxShadow:'-12px 0 32px rgba(0,0,0,0.3)',
      }}>
        <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:14,fontWeight:600}}>Add distributor</div>
          <button onClick={onClose} style={{background:'transparent',border:'none',color:T.text2,fontSize:20,cursor:'pointer',padding:'0 4px'}}>×</button>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:20}}>
          {step === 'search' && (
            <CustomerSearch onPick={pickCustomer}/>
          )}

          {step === 'details' && picked && (
            <div>
              {/* Picked summary */}
              <div style={{
                padding:'10px 12px',background:T.bg3,border:`1px solid ${T.blue}40`,borderRadius:7,
                marginBottom:18,display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,
              }}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,color:T.text3,marginBottom:2}}>MYOB Customer</div>
                  <div style={{fontSize:13,color:T.text,fontWeight:500}}>{picked.name}</div>
                  <div style={{fontFamily:'monospace',fontSize:10,color:T.text3,marginTop:2}}>
                    {picked.display_id} · {picked.uid}
                  </div>
                </div>
                <button onClick={() => { setPicked(null); setStep('search') }}
                  style={{padding:'5px 10px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                  Change
                </button>
              </div>

              <FormRow label="Display name" hint="How this distributor appears in the portal">
                <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} style={input}/>
              </FormRow>
              <FormRow label="ABN" hint="Optional">
                <input type="text" value={abn} onChange={e => setAbn(e.target.value)} placeholder="e.g. 12 345 678 901" style={input}/>
              </FormRow>
              <FormRow label="Primary contact email" hint="Used for shipping notifications">
                <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} style={input}/>
              </FormRow>
              <FormRow label="Primary contact phone" hint="Optional">
                <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} style={input}/>
              </FormRow>
              <FormRow label="Internal notes" hint="Only visible to staff">
                <textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} style={{...input,resize:'vertical'}}/>
              </FormRow>

              {error && (
                <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:11,marginTop:10}}>
                  {error}
                </div>
              )}

              <div style={{marginTop:20,display:'flex',gap:10}}>
                <button onClick={save} disabled={saving || !displayName.trim()}
                  style={{
                    flex:1,padding:'10px 16px',borderRadius:6,
                    border:`1px solid ${saving ? T.border2 : T.blue}`,
                    background: saving ? T.bg3 : T.blue,
                    color: saving ? T.text3 : '#fff',
                    fontSize:13,fontWeight:500,cursor:saving?'wait':'pointer',fontFamily:'inherit',
                  }}>
                  {saving ? 'Creating…' : 'Create distributor'}
                </button>
                <button onClick={onClose} disabled={saving}
                  style={{padding:'10px 14px',borderRadius:6,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:12,cursor:'pointer',fontFamily:'inherit'}}>
                  Cancel
                </button>
              </div>

              <div style={{fontSize:10,color:T.text3,marginTop:14,lineHeight:1.5}}>
                After creating, you can link a Tuning customer card and invite users from the detail page.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── MYOB customer typeahead ───────────────────────────────────────────
function CustomerSearch({ onPick }: { onPick: (c: MyobCustomer) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<MyobCustomer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounced search
  useEffect(() => {
    const handle = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(`/api/b2b/admin/myob/customers?q=${encodeURIComponent(q)}&limit=20`,
          { credentials: 'same-origin' })
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
        setResults(j.items || [])
      } catch (e: any) {
        setError(e?.message || String(e))
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => clearTimeout(handle)
  }, [q])

  return (
    <div>
      <div style={{fontSize:11,color:T.text3,textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:8}}>
        Step 1 · Pick a MYOB customer
      </div>
      <input
        type="text"
        placeholder="Type to search MYOB JAWS customers…"
        value={q}
        onChange={e => setQ(e.target.value)}
        autoFocus
        style={{
          width:'100%',
          background:T.bg3,border:`1px solid ${T.border2}`,color:T.text,
          borderRadius:6,padding:'10px 12px',fontSize:13,outline:'none',fontFamily:'inherit',
          marginBottom:10,
        }}
      />

      {loading && <div style={{fontSize:11,color:T.text3,padding:'8px 4px'}}>Searching MYOB…</div>}
      {error && (
        <div style={{padding:10,background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,color:T.red,fontSize:11}}>
          {error}
        </div>
      )}

      {!loading && !error && results.length === 0 && q && (
        <div style={{fontSize:12,color:T.text3,padding:'12px 4px'}}>
          No matches in MYOB. Check spelling or try a customer code.
        </div>
      )}

      {!loading && !error && results.length === 0 && !q && (
        <div style={{fontSize:12,color:T.text3,padding:'12px 4px'}}>
          Start typing to search MYOB customer cards.
        </div>
      )}

      {results.length > 0 && (
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          {results.map(c => (
            <button key={c.uid} onClick={() => onPick(c)}
              style={{
                textAlign:'left',padding:'10px 12px',
                background:T.bg3,border:`1px solid ${T.border}`,borderRadius:6,
                color:T.text,cursor:'pointer',fontFamily:'inherit',
                display:'flex',alignItems:'center',justifyContent:'space-between',gap:10,
              }}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:500}}>{c.name}</div>
                <div style={{fontFamily:'monospace',fontSize:10,color:T.text3,marginTop:2}}>
                  {c.display_id || '—'}
                  {c.is_individual && <span style={{marginLeft:8,color:T.purple}}>· Individual</span>}
                </div>
              </div>
              <span style={{color:T.text3,fontSize:14}}>›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── small components ──────────────────────────────────────────────────
function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:11,color:T.text2,marginBottom:4,fontWeight:500}}>{label}</div>
      {children}
      {hint && <div style={{fontSize:10,color:T.text3,marginTop:3}}>{hint}</div>}
    </div>
  )
}

const input: React.CSSProperties = {
  width:'100%',
  background:T.bg3,border:`1px solid ${T.border}`,color:T.text,
  borderRadius:5,padding:'8px 11px',fontSize:12,outline:'none',fontFamily:'inherit',
}

function th(width?: number): React.CSSProperties {
  return {
    fontSize:10,color:T.text3,padding:'10px 12px',
    textAlign:'left',fontWeight:500,
    textTransform:'uppercase',letterSpacing:'0.05em',
    width,whiteSpace:'nowrap',background:T.bg2,
  }
}
function td(): React.CSSProperties {
  return { padding:'12px 12px',verticalAlign:'middle' }
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'edit:b2b_distributors')
}

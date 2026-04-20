// pages/admin/vin-codes.tsx — Admin UI for VIN prefix → model code mappings
import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface VinRule { id: number; vin_prefix: string; model_code: string; friendly_name: string | null; notes: string | null }
interface Observed { prefix: string; occurrences: number; sample_value: string }

// Heuristic — does this prefix look like a real VIN start?
// VIN chars are A-Z and 0-9, no I/O/Q in real VINs but MYOB has typos (MROH with letter O).
// We treat all-uppercase-alphanumeric as "looks like VIN"; anything else (lowercase, spaces, symbols) is not.
function looksLikeVinPrefix(p: string): boolean {
  if (!p || p.length < 4) return false
  return /^[A-Z0-9]{4,}$/.test(p)
}

export default function VinCodesAdmin() {
  const router = useRouter()
  const isEmbed = router.query.embed === '1'
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rules, setRules] = useState<VinRule[]>([])
  const [observed, setObserved] = useState<Observed[]>([])
  const [tab, setTab] = useState<'unmapped'|'mapped'>('unmapped')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const [rRes, oRes] = await Promise.all([
        fetch('/api/vin-codes'),
        fetch('/api/vin-codes/observed'),
      ])
      if (rRes.status === 401) { router.push('/login'); return }
      if (!rRes.ok) throw new Error('Failed to load VIN rules')
      const rData = await rRes.json()
      setRules(rData.rules || [])
      if (oRes.ok) {
        const oData = await oRes.json()
        setObserved(oData.observed || [])
      }
      setError('')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [router])
  useEffect(() => { load() }, [load])

  async function mutate(action: string, payload: any) {
    setSaving(true)
    try {
      const r = await fetch('/api/vin-codes/mutate', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({action, payload}),
      })
      if (!r.ok) {
        const err = await r.json().catch(()=>({error:'Save failed'}))
        throw new Error(err.error || 'Save failed')
      }
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setSaving(false) }
  }

  // Derived
  const mappedPrefixes = new Set(rules.map(r => r.vin_prefix.toUpperCase()))
  const unmappedObserved = observed.filter(o => looksLikeVinPrefix(o.prefix.toUpperCase()) && !mappedPrefixes.has(o.prefix.toUpperCase()))
  const uniqueModelCodes = Array.from(new Set(rules.map(r => r.model_code))).sort()

  return (
    <>
      <Head><title>VIN Codes Admin — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        {!isEmbed && <PortalSidebar activeId="distributors"/>}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          {!isEmbed && (
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:600}}>VIN Codes Admin</div>
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(167,139,250,0.12)',color:T.purple,border:'1px solid rgba(167,139,250,0.2)'}}>Supabase</span>
            <div style={{flex:1}}/>
            <span style={{fontSize:11,color:T.text3}}>
              {rules.length} rules · {unmappedObserved.length} unmapped VIN prefixes
              {saving && ' · saving…'}
            </span>
            <button onClick={()=>router.push('/admin/groups')}
              style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
              Groups Admin
            </button>
            <button onClick={()=>router.push('/distributors')}
              style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
              ← Back
            </button>
          </div>
          )}

          <div style={{display:'flex',gap:2,padding:'0 20px',background:T.bg2,borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
            {(['unmapped','mapped'] as const).map(k => (
              <button key={k} onClick={()=>setTab(k)}
                style={{fontSize:12,padding:'10px 16px',border:'none',borderBottom:tab===k?`2px solid ${T.accent}`:'2px solid transparent',background:'transparent',color:tab===k?T.accent:T.text2,cursor:'pointer',fontFamily:'inherit'}}>
                {k === 'unmapped' ? `Unmapped VINs (${unmappedObserved.length})` : `Mapped rules (${rules.length})`}
              </button>
            ))}
          </div>

          <div style={{flex:1,overflowY:'auto',padding:20}}>
            {error && <div style={{background:'rgba(240,78,78,0.1)',border:`1px solid ${T.red}40`,borderRadius:8,padding:12,marginBottom:16,color:T.red,fontSize:12}}>{error}</div>}
            {loading && <div style={{color:T.text3,textAlign:'center',padding:40}}>Loading…</div>}

            {!loading && tab === 'unmapped' && (
              <UnmappedTab unmapped={unmappedObserved} uniqueModelCodes={uniqueModelCodes}
                onMap={(prefix, model_code, friendly_name)=>mutate('upsert',{vin_prefix:prefix, model_code, friendly_name})}
              />
            )}

            {!loading && tab === 'mapped' && (
              <MappedTab rules={rules} uniqueModelCodes={uniqueModelCodes}
                onSave={(rule)=>mutate('upsert', rule)}
                onDelete={(id)=>mutate('delete', {id})}
              />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
function UnmappedTab({unmapped, uniqueModelCodes, onMap}: {
  unmapped: Observed[]; uniqueModelCodes: string[]
  onMap: (prefix: string, model_code: string, friendly_name: string) => void
}) {
  const [values, setValues] = useState<Record<string, {model:string;friendly:string}>>({})

  return <div style={{display:'flex',flexDirection:'column',gap:16}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>What this tab does</div>
      <div style={{fontSize:12,color:T.text2,lineHeight:1.6}}>
        Shows VIN prefixes observed in MYOB invoices that don't have a model rule yet.
        Only VIN-shaped prefixes (uppercase alphanumeric) are shown — customer names, PO refs, and stock codes are filtered out.
        Add a model code to start grouping invoices from that prefix.
      </div>
    </div>

    {unmapped.length === 0 ? (
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:40,textAlign:'center',color:T.text3}}>
        <div style={{fontSize:40,marginBottom:10,color:T.green}}>✓</div>
        <div style={{fontSize:14,color:T.text}}>All observed VIN prefixes are mapped.</div>
        <div style={{fontSize:12,marginTop:6}}>New VINs will appear here as they're invoiced.</div>
      </div>
    ) : (
      <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
        <datalist id="model-codes">{uniqueModelCodes.map(m => <option key={m} value={m}/>)}</datalist>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Prefix</th>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Invoices</th>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Sample VIN</th>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Model code</th>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Friendly name</th>
            <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}></th>
          </tr></thead>
          <tbody>{unmapped.map(u => {
            const v = values[u.prefix] || {model:'', friendly:''}
            const canSave = v.model.trim().length > 0
            return <tr key={u.prefix} style={{borderTop:`1px solid ${T.border}`}}>
              <td style={{fontSize:13,fontFamily:'monospace',color:T.amber,padding:'8px 12px',fontWeight:600}}>{u.prefix}</td>
              <td style={{fontSize:12,fontFamily:'monospace',color:T.text,padding:'8px 12px',textAlign:'right'}}>{u.occurrences}</td>
              <td style={{fontSize:11,fontFamily:'monospace',color:T.text3,padding:'8px 12px'}}>{u.sample_value?.substring(0,24) || '—'}</td>
              <td style={{padding:'8px 12px'}}>
                <input list="model-codes" placeholder="e.g. GUN126R" value={v.model}
                  onChange={e=>setValues({...values,[u.prefix]:{...v,model:e.target.value}})}
                  style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,width:140,outline:'none',fontFamily:'monospace'}}/>
              </td>
              <td style={{padding:'8px 12px'}}>
                <input placeholder="e.g. Hilux N80" value={v.friendly}
                  onChange={e=>setValues({...values,[u.prefix]:{...v,friendly:e.target.value}})}
                  style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,width:160,outline:'none'}}/>
              </td>
              <td style={{padding:'8px 12px',textAlign:'right'}}>
                <button onClick={()=>{
                  if (canSave) {
                    onMap(u.prefix, v.model.trim(), v.friendly.trim())
                    setValues({...values, [u.prefix]: {model:'', friendly:''}})
                  }
                }} disabled={!canSave}
                  style={{padding:'4px 12px',borderRadius:4,border:'none',background:canSave?T.blue:T.bg4,color:canSave?'#fff':T.text3,fontSize:11,cursor:canSave?'pointer':'not-allowed',fontFamily:'inherit'}}>
                  Map
                </button>
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>
    )}
  </div>
}

// ─────────────────────────────────────────────────────────────
function MappedTab({rules, uniqueModelCodes, onSave, onDelete}: {
  rules: VinRule[]; uniqueModelCodes: string[]
  onSave: (rule: any) => void
  onDelete: (id: number) => void
}) {
  const [search, setSearch] = useState('')
  const [newPrefix, setNewPrefix] = useState('')
  const [newModel, setNewModel] = useState('')
  const [newFriendly, setNewFriendly] = useState('')

  const sorted = [...rules].sort((a,b) => a.vin_prefix.localeCompare(b.vin_prefix))
  const filtered = sorted.filter(r => !search ||
    r.vin_prefix.toLowerCase().includes(search.toLowerCase()) ||
    r.model_code.toLowerCase().includes(search.toLowerCase()) ||
    (r.friendly_name || '').toLowerCase().includes(search.toLowerCase())
  )

  return <div style={{display:'flex',flexDirection:'column',gap:16}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>Add a new rule</div>
      <div style={{display:'flex',gap:8,alignItems:'center'}}>
        <input placeholder="VIN prefix (e.g. JTEB)" value={newPrefix}
          onChange={e=>setNewPrefix(e.target.value.toUpperCase())}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,width:140,outline:'none',fontFamily:'monospace'}}/>
        <input list="model-codes-all" placeholder="Model code (e.g. VDJ79R)" value={newModel}
          onChange={e=>setNewModel(e.target.value)}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,width:180,outline:'none',fontFamily:'monospace'}}/>
        <input placeholder="Friendly name (e.g. LC79 Series)" value={newFriendly}
          onChange={e=>setNewFriendly(e.target.value)}
          style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'6px 10px',fontSize:12,outline:'none'}}/>
        <button onClick={()=>{
          if(newPrefix && newModel) {
            onSave({vin_prefix:newPrefix, model_code:newModel, friendly_name:newFriendly || null})
            setNewPrefix(''); setNewModel(''); setNewFriendly('')
          }
        }} disabled={!newPrefix || !newModel}
          style={{padding:'6px 16px',borderRadius:4,border:'none',background:(newPrefix&&newModel)?T.blue:T.bg4,color:(newPrefix&&newModel)?'#fff':T.text3,fontSize:12,cursor:(newPrefix&&newModel)?'pointer':'not-allowed',fontFamily:'inherit'}}>
          Add
        </button>
      </div>
    </div>

    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,overflowX:'auto'}}>
      <datalist id="model-codes-all">{uniqueModelCodes.map(m => <option key={m} value={m}/>)}</datalist>
      <div style={{display:'flex',gap:10,alignItems:'center',padding:'12px 16px',borderBottom:`1px solid ${T.border}`}}>
        <div style={{fontSize:13,fontWeight:600,color:T.text}}>All rules ({rules.length})</div>
        <div style={{flex:1}}/>
        <input placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'5px 10px',fontSize:12,width:220,outline:'none'}}/>
      </div>
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
          <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Prefix</th>
          <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Model code</th>
          <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Friendly name</th>
          <th style={{fontSize:10,color:T.text3,padding:'10px 12px',textAlign:'right',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}></th>
        </tr></thead>
        <tbody>{filtered.map(r => (
          <RuleRow key={r.id} rule={r} uniqueModelCodes={uniqueModelCodes} onSave={onSave} onDelete={onDelete}/>
        ))}
        {filtered.length === 0 && (
          <tr><td colSpan={4} style={{padding:24,textAlign:'center',color:T.text3,fontSize:12}}>
            {search ? `No rules match "${search}"` : 'No rules yet — add one above.'}
          </td></tr>
        )}
        </tbody>
      </table>
    </div>
  </div>
}

function RuleRow({rule, uniqueModelCodes, onSave, onDelete}: {
  rule: VinRule; uniqueModelCodes: string[]
  onSave: (r: any) => void; onDelete: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [model, setModel] = useState(rule.model_code)
  const [friendly, setFriendly] = useState(rule.friendly_name || '')

  if (editing) return <tr style={{borderTop:`1px solid ${T.border}`,background:T.bg3}}>
    <td style={{fontSize:12,fontFamily:'monospace',color:T.blue,padding:'8px 12px',fontWeight:600}}>{rule.vin_prefix}</td>
    <td style={{padding:'6px 12px'}}>
      <input list="model-codes-all" value={model} onChange={e=>setModel(e.target.value)}
        style={{background:T.bg2,border:`1px solid ${T.blue}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,width:160,outline:'none',fontFamily:'monospace'}}/>
    </td>
    <td style={{padding:'6px 12px'}}>
      <input value={friendly} onChange={e=>setFriendly(e.target.value)}
        style={{background:T.bg2,border:`1px solid ${T.blue}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,width:200,outline:'none'}}/>
    </td>
    <td style={{padding:'6px 12px',textAlign:'right'}}>
      <button onClick={()=>{onSave({id:rule.id, vin_prefix:rule.vin_prefix, model_code:model, friendly_name:friendly || null}); setEditing(false)}}
        style={{padding:'4px 10px',borderRadius:4,border:'none',background:T.blue,color:'#fff',fontSize:11,cursor:'pointer',fontFamily:'inherit',marginRight:4}}>
        Save
      </button>
      <button onClick={()=>{setModel(rule.model_code); setFriendly(rule.friendly_name||''); setEditing(false)}}
        style={{padding:'4px 10px',borderRadius:4,border:'none',background:'transparent',color:T.text3,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
        Cancel
      </button>
    </td>
  </tr>

  return <tr style={{borderTop:`1px solid ${T.border}`}}>
    <td style={{fontSize:12,fontFamily:'monospace',color:T.blue,padding:'8px 12px',fontWeight:600}}>{rule.vin_prefix}</td>
    <td style={{fontSize:12,fontFamily:'monospace',color:T.green,padding:'8px 12px'}}>{rule.model_code}</td>
    <td style={{fontSize:12,color:T.text2,padding:'8px 12px'}}>{rule.friendly_name || '—'}</td>
    <td style={{padding:'8px 12px',textAlign:'right'}}>
      <button onClick={()=>setEditing(true)}
        style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
        Edit
      </button>
      <button onClick={()=>{if(confirm(`Delete rule for "${rule.vin_prefix}"?`)) onDelete(rule.id)}}
        style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.red,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
        Delete
      </button>
    </td>
  </tr>
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'admin:settings')
}

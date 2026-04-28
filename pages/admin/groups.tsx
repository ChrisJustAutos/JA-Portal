// pages/admin/groups.tsx — Distributor grouping admin UI
// Reachable at /admin/groups
import { useEffect, useState, useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import PortalSidebar from '../../lib/PortalSidebar'
import { requirePageAuth } from '../../lib/authServer'
import ExclusionsTab from '../../components/admin/ExclusionsTab'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

interface Alias { myob_name: string; canonical_name: string }
interface Group { id: number; dimension: string; name: string; sort_order: number; color: string | null }
interface Member { group_id: number; canonical_name: string }

export default function GroupsAdmin() {
  const router = useRouter()
  const isEmbed = router.query.embed === '1'
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [aliases, setAliases] = useState<Alias[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [myobCustomers, setMyobCustomers] = useState<string[]>([])
  const [tab, setTab] = useState<'aliases'|'groups'|'members'|'exclusions'>('aliases')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const [gRes, mRes] = await Promise.all([
        fetch('/api/groups'),
        fetch('/api/groups/myob-customers'),
      ])
      if (gRes.status === 401) { router.push('/login'); return }
      if (!gRes.ok) throw new Error('Failed to load groups')
      const g = await gRes.json()
      setAliases(g.aliases || [])
      setGroups(g.groups || [])
      setMembers(g.members || [])
      if (mRes.ok) {
        const m = await mRes.json()
        setMyobCustomers(m.customers || [])
      }
      setError('')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [router])
  useEffect(() => { load() }, [load])

  async function mutate(action: string, payload: any) {
    setSaving(true)
    try {
      const r = await fetch('/api/groups/mutate', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({action, payload})
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
  const canonicalNames = Array.from(new Set(aliases.map(a => a.canonical_name))).sort()
  const unclassified = myobCustomers.filter(mn => !aliases.some(a => a.myob_name === mn))
  const byDimension: Record<string, Group[]> = {}
  groups.forEach(g => {
    if (!byDimension[g.dimension]) byDimension[g.dimension] = []
    byDimension[g.dimension].push(g)
  })
  Object.keys(byDimension).forEach(d => byDimension[d].sort((a,b)=>a.sort_order-b.sort_order))

  return (
    <>
      <Head><title>Groups Admin — Just Autos</title><meta name="robots" content="noindex,nofollow"/></Head>
      <div style={{display:'flex',height:'100vh',overflow:'hidden',fontFamily:"'DM Sans',system-ui,sans-serif",color:T.text}}>
        {!isEmbed && <PortalSidebar activeId="distributors"/>}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',background:T.bg}}>
          {!isEmbed && (
          <div style={{height:52,background:T.bg2,borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:12,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:600}}>Groups Admin</div>
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 8px',borderRadius:4,background:'rgba(167,139,250,0.12)',color:T.purple,border:'1px solid rgba(167,139,250,0.2)'}}>Supabase</span>
            <div style={{flex:1}}/>
            <span style={{fontSize:11,color:T.text3}}>
              {aliases.length} aliases · {groups.length} groups · {members.length} memberships
              {saving && ' · saving…'}
            </span>
            <button onClick={()=>router.push('/distributors')}
              style={{padding:'5px 12px',borderRadius:5,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
              ← Back to Distributors
            </button>
          </div>
          )}

          <div style={{display:'flex',gap:2,padding:'0 20px',background:T.bg2,borderBottom:`1px solid ${T.border}`,flexShrink:0}}>
            {(['aliases','groups','members','exclusions'] as const).map(k => (
              <button key={k} onClick={()=>setTab(k)}
                style={{fontSize:12,padding:'10px 16px',border:'none',borderBottom:tab===k?`2px solid ${T.accent}`:'2px solid transparent',background:'transparent',color:tab===k?T.accent:T.text2,cursor:'pointer',fontFamily:'inherit',textTransform:'capitalize'}}>
                {k === 'aliases' ? `Aliases & Merges (${aliases.length})`
                  : k === 'groups' ? `Groups (${groups.length})`
                  : k === 'members' ? `Membership (${members.length})`
                  : 'Exclusions'}
              </button>
            ))}
          </div>

          <div style={{flex:1,overflowY:'auto',padding:20}}>
            {error && <div style={{background:'rgba(240,78,78,0.1)',border:`1px solid ${T.red}40`,borderRadius:8,padding:12,marginBottom:16,color:T.red,fontSize:12}}>{error}</div>}
            {loading && <div style={{color:T.text3,textAlign:'center',padding:40}}>Loading…</div>}

            {!loading && tab === 'aliases' && (
              <AliasesTab aliases={aliases} unclassified={unclassified} canonicalNames={canonicalNames}
                onSave={(myob_name, canonical_name)=>mutate('setAlias',{myob_name,canonical_name})}
                onDelete={(myob_name)=>mutate('deleteAlias',{myob_name})}
              />
            )}

            {!loading && tab === 'groups' && (
              <GroupsTab byDimension={byDimension}
                onCreate={(dim, name, color)=>mutate('createGroup',{dimension:dim,name,color,sort_order:(byDimension[dim]?.length||0)+1})}
                onUpdate={(id,patch)=>mutate('updateGroup',{id,...patch})}
                onDelete={(id)=>mutate('deleteGroup',{id})}
              />
            )}

            {!loading && tab === 'members' && (
              <MembersTab groups={groups} members={members} canonicalNames={canonicalNames}
                onToggle={(groupId,canonical,currentlyMember)=>
                  mutate(currentlyMember?'removeMember':'addMember',{group_id:groupId,canonical_name:canonical})
                }
              />
            )}

            {tab === 'exclusions' && (
              <ExclusionsTab myobCustomers={myobCustomers} />
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────
function AliasesTab({aliases, unclassified, canonicalNames, onSave, onDelete}: {
  aliases: Alias[]; unclassified: string[]; canonicalNames: string[]
  onSave: (myob: string, canonical: string) => void
  onDelete: (myob: string) => void
}) {
  const [search, setSearch] = useState('')
  const [newCanonical, setNewCanonical] = useState<Record<string,string>>({})
  const filtered = aliases.filter(a => !search || a.myob_name.toLowerCase().includes(search.toLowerCase()) || a.canonical_name.toLowerCase().includes(search.toLowerCase()))
  const groupedByCanonical: Record<string, Alias[]> = {}
  aliases.forEach(a => {
    if (!groupedByCanonical[a.canonical_name]) groupedByCanonical[a.canonical_name] = []
    groupedByCanonical[a.canonical_name].push(a)
  })
  const mergedEntities = Object.entries(groupedByCanonical).filter(([,arr]) => arr.length > 1).sort((a,b)=>b[1].length-a[1].length)

  return <div style={{display:'flex',flexDirection:'column',gap:20}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>What this tab does</div>
      <div style={{fontSize:12,color:T.text2,lineHeight:1.6}}>
        Maps raw MYOB customer names to a single canonical name for reporting.
        When two or more MYOB cards share a canonical name they roll up into one entity on the Distributors page
        (example: "Harrop Engineering Australia Pty Ltd" + "Harrop Engineering Australia Pty Ltd (Tuning 2)" → "Harrop Engineering").
      </div>
    </div>

    {unclassified.length > 0 && (
      <div style={{background:T.bg2,border:`1px solid ${T.amber}40`,borderRadius:10,padding:16}}>
        <div style={{fontSize:13,fontWeight:600,color:T.amber,marginBottom:10}}>
          ⚠ {unclassified.length} MYOB customer{unclassified.length===1?'':'s'} not yet classified
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {unclassified.map(mn => (
            <div key={mn} style={{display:'flex',gap:8,alignItems:'center',padding:'6px 0',borderBottom:`1px solid ${T.border}`}}>
              <span style={{flex:1,fontSize:12,color:T.text,fontFamily:'monospace'}}>{mn}</span>
              <input placeholder="Canonical name…" value={newCanonical[mn] || ''} onChange={e=>setNewCanonical({...newCanonical,[mn]:e.target.value})}
                list="canonicals"
                style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:11,width:240,outline:'none'}}/>
              <button onClick={()=>{if(newCanonical[mn]) onSave(mn, newCanonical[mn])}}
                disabled={!newCanonical[mn]}
                style={{padding:'4px 10px',borderRadius:4,border:'none',background:newCanonical[mn]?T.blue:T.bg4,color:newCanonical[mn]?'#fff':T.text3,fontSize:11,cursor:newCanonical[mn]?'pointer':'not-allowed',fontFamily:'inherit'}}>
                Add
              </button>
            </div>
          ))}
        </div>
      </div>
    )}

    {mergedEntities.length > 0 && <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>Merged entities ({mergedEntities.length})</div>
      <div style={{fontSize:11,color:T.text3,marginBottom:12}}>These canonical names combine 2+ MYOB cards.</div>
      {mergedEntities.map(([canonical, arr]) => (
        <div key={canonical} style={{marginBottom:12,paddingBottom:12,borderBottom:`1px solid ${T.border}`}}>
          <div style={{fontSize:13,fontWeight:500,color:T.green,marginBottom:4}}>{canonical} <span style={{color:T.text3,fontSize:11,fontFamily:'monospace'}}>({arr.length} cards)</span></div>
          <div style={{paddingLeft:16,fontSize:11,color:T.text2,fontFamily:'monospace'}}>{arr.map(a => a.myob_name).join(' · ')}</div>
        </div>
      ))}
    </div>}

    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:600,color:T.text}}>All aliases ({aliases.length})</div>
        <div style={{flex:1}}/>
        <input placeholder="Search…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'5px 10px',fontSize:12,width:240,outline:'none'}}/>
      </div>
      <datalist id="canonicals">{canonicalNames.map(cn => <option key={cn} value={cn}/>)}</datalist>
      <table style={{width:'100%',borderCollapse:'collapse'}}>
        <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
          <th style={{fontSize:10,color:T.text3,padding:'8px 10px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>MYOB raw name</th>
          <th style={{fontSize:10,color:T.text3,padding:'8px 10px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}>Canonical name</th>
          <th style={{fontSize:10,color:T.text3,padding:'8px 10px',textAlign:'right',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em'}}></th>
        </tr></thead>
        <tbody>{filtered.map(a => (
          <AliasRow key={a.myob_name} alias={a} canonicalNames={canonicalNames} onSave={onSave} onDelete={onDelete}/>
        ))}</tbody>
      </table>
    </div>
  </div>
}

function AliasRow({alias, canonicalNames, onSave, onDelete}: {
  alias: Alias; canonicalNames: string[]
  onSave: (myob: string, canonical: string) => void
  onDelete: (myob: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(alias.canonical_name)
  return <tr style={{borderTop:`1px solid ${T.border}`}}>
    <td style={{fontSize:12,color:T.text2,padding:'8px 10px',fontFamily:'monospace'}}>{alias.myob_name}</td>
    <td style={{padding:'8px 10px'}}>
      {editing ? (
        <input autoFocus value={value} onChange={e=>setValue(e.target.value)} list="canonicals"
          onBlur={()=>{ if(value && value !== alias.canonical_name) onSave(alias.myob_name, value); setEditing(false) }}
          onKeyDown={(e)=>{
            if(e.key==='Enter'){ if(value && value !== alias.canonical_name) onSave(alias.myob_name, value); setEditing(false) }
            if(e.key==='Escape'){ setValue(alias.canonical_name); setEditing(false) }
          }}
          style={{background:T.bg3,border:`1px solid ${T.blue}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,width:260,outline:'none'}}/>
      ) : (
        <span onClick={()=>setEditing(true)} style={{fontSize:12,color:T.green,cursor:'pointer',display:'inline-block',padding:'2px 6px',borderRadius:3}}>{alias.canonical_name}</span>
      )}
    </td>
    <td style={{padding:'8px 10px',textAlign:'right'}}>
      <button onClick={()=>{if(confirm(`Delete alias for "${alias.myob_name}"?`)) onDelete(alias.myob_name)}}
        style={{padding:'3px 8px',borderRadius:4,border:'none',background:'transparent',color:T.text3,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
        Remove
      </button>
    </td>
  </tr>
}

// ─────────────────────────────────────────────────────────────
function GroupsTab({byDimension, onCreate, onUpdate, onDelete}: {
  byDimension: Record<string, Group[]>
  onCreate: (dim: string, name: string, color: string) => void
  onUpdate: (id: number, patch: any) => void
  onDelete: (id: number) => void
}) {
  const [newDim, setNewDim] = useState('')
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#4f8ef7')
  const [addingToDim, setAddingToDim] = useState<string|null>(null)
  const dims = Object.keys(byDimension)

  return <div style={{display:'flex',flexDirection:'column',gap:20}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>What this tab does</div>
      <div style={{fontSize:12,color:T.text2,lineHeight:1.6}}>
        Groups are organised by dimension. Each dimension is a way of slicing your distributors (e.g. "type" has Distributors/Sundry/Excluded; "region" has National/International). You can add new dimensions to track things like state, tier, or account manager over time.
      </div>
    </div>

    {dims.map(dim => (
      <div key={dim} style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:T.text,textTransform:'capitalize'}}>{dim}</div>
          <span style={{fontSize:11,color:T.text3}}>{byDimension[dim].length} groups</span>
          <div style={{flex:1}}/>
          <button onClick={()=>setAddingToDim(addingToDim===dim?null:dim)}
            style={{padding:'4px 10px',borderRadius:4,border:`1px solid ${T.border2}`,background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
            + Add group
          </button>
        </div>

        {addingToDim === dim && (
          <div style={{display:'flex',gap:8,marginBottom:12,padding:10,background:T.bg3,borderRadius:6}}>
            <input placeholder="Group name…" value={newName} onChange={e=>setNewName(e.target.value)}
              style={{flex:1,background:T.bg2,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'5px 10px',fontSize:12,outline:'none'}}/>
            <input type="color" value={newColor} onChange={e=>setNewColor(e.target.value)}
              style={{width:36,height:28,background:'transparent',border:`1px solid ${T.border}`,borderRadius:4,cursor:'pointer'}}/>
            <button onClick={()=>{if(newName){onCreate(dim,newName,newColor);setNewName('');setAddingToDim(null)}}}
              disabled={!newName}
              style={{padding:'5px 12px',borderRadius:4,border:'none',background:newName?T.blue:T.bg4,color:newName?'#fff':T.text3,fontSize:11,cursor:newName?'pointer':'not-allowed',fontFamily:'inherit'}}>
              Create
            </button>
          </div>
        )}

        <div style={{display:'flex',flexDirection:'column',gap:6}}>
          {byDimension[dim].map(g => (
            <GroupRow key={g.id} group={g} onUpdate={onUpdate} onDelete={onDelete}/>
          ))}
        </div>
      </div>
    ))}

    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:12,fontWeight:600,color:T.text3,marginBottom:10,textTransform:'uppercase',letterSpacing:'0.05em'}}>Add a new dimension</div>
      <div style={{display:'flex',gap:8}}>
        <input placeholder="e.g. state, tier, account_manager" value={newDim} onChange={e=>setNewDim(e.target.value)}
          style={{flex:1,background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'5px 10px',fontSize:12,outline:'none'}}/>
        <button onClick={()=>{
          if(!newDim) return
          const grp = prompt(`First group name in "${newDim}" dimension?`)
          if(grp){ onCreate(newDim.toLowerCase().replace(/\s+/g,'_'), grp, '#4f8ef7'); setNewDim('') }
        }} disabled={!newDim}
          style={{padding:'5px 12px',borderRadius:4,border:'none',background:newDim?T.blue:T.bg4,color:newDim?'#fff':T.text3,fontSize:11,cursor:newDim?'pointer':'not-allowed',fontFamily:'inherit'}}>
          Create dimension
        </button>
      </div>
    </div>
  </div>
}

function GroupRow({group, onUpdate, onDelete}: {group: Group; onUpdate: (id:number,patch:any)=>void; onDelete: (id:number)=>void}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [color, setColor] = useState(group.color || '#4f8ef7')
  return <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:T.bg3,borderRadius:6}}>
    <div style={{width:10,height:10,borderRadius:3,background:group.color||T.text3,flexShrink:0}}/>
    {editing ? (
      <>
        <input value={name} onChange={e=>setName(e.target.value)} autoFocus
          style={{flex:1,background:T.bg2,border:`1px solid ${T.blue}`,color:T.text,borderRadius:4,padding:'3px 8px',fontSize:12,outline:'none'}}/>
        <input type="color" value={color} onChange={e=>setColor(e.target.value)}
          style={{width:28,height:24,background:'transparent',border:`1px solid ${T.border}`,borderRadius:3,cursor:'pointer'}}/>
        <button onClick={()=>{onUpdate(group.id,{name,color}); setEditing(false)}}
          style={{padding:'3px 8px',borderRadius:3,border:'none',background:T.blue,color:'#fff',fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
          Save
        </button>
        <button onClick={()=>{setName(group.name); setColor(group.color||'#4f8ef7'); setEditing(false)}}
          style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.text3,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
          Cancel
        </button>
      </>
    ) : (
      <>
        <div style={{flex:1,fontSize:12,color:T.text}}>{group.name}</div>
        <span style={{fontSize:10,color:T.text3,fontFamily:'monospace'}}>sort:{group.sort_order}</span>
        <button onClick={()=>setEditing(true)}
          style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.text2,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
          Edit
        </button>
        <button onClick={()=>{if(confirm(`Delete group "${group.name}"?\nAll memberships in this group will also be removed.`)) onDelete(group.id)}}
          style={{padding:'3px 8px',borderRadius:3,border:'none',background:'transparent',color:T.red,fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
          Delete
        </button>
      </>
    )}
  </div>
}

// ─────────────────────────────────────────────────────────────
function MembersTab({groups, members, canonicalNames, onToggle}: {
  groups: Group[]; members: Member[]; canonicalNames: string[]
  onToggle: (groupId: number, canonical: string, currentlyMember: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const [dimension, setDimension] = useState<string>('type')
  const dims = Array.from(new Set(groups.map(g => g.dimension)))
  const groupsInDim = groups.filter(g => g.dimension === dimension).sort((a,b)=>a.sort_order-b.sort_order)
  const membersByGroup: Record<number, Set<string>> = {}
  members.forEach(m => {
    if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = new Set()
    membersByGroup[m.group_id].add(m.canonical_name)
  })

  // ── Eligibility filter ─────────────────────────────────────
  // For non-type dimensions (e.g. region) only show customers that have
  // been classified as the 'Distributors' group in the type dimension.
  // Sundry / Excluded / Internal customers don't need a region, so showing
  // them here is just visual noise. Type dimension itself shows everyone
  // (you classify INTO a type from this view, so unclassified customers
  // need to be visible).
  const distributorsTypeGroup = groups.find(g => g.dimension === 'type' && g.name === 'Distributors')
  const distributorMembers = distributorsTypeGroup ? (membersByGroup[distributorsTypeGroup.id] || new Set()) : new Set<string>()
  const eligibleNames = dimension === 'type'
    ? canonicalNames
    : canonicalNames.filter(cn => distributorMembers.has(cn))
  const filtered = eligibleNames.filter(cn => !search || cn.toLowerCase().includes(search.toLowerCase()))

  // For yellow-outline highlighting: in any dimension, a distributor is
  // 'unassigned' if it isn't a member of any group in the current dimension.
  function isUnassigned(cn: string): boolean {
    return !groupsInDim.some(g => membersByGroup[g.id]?.has(cn))
  }
  const unassignedCount = filtered.filter(isUnassigned).length

  return <div style={{display:'flex',flexDirection:'column',gap:14}}>
    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{fontSize:13,fontWeight:600,color:T.text,marginBottom:10}}>What this tab does</div>
      <div style={{fontSize:12,color:T.text2,lineHeight:1.6}}>
        Click checkboxes to add or remove a canonical distributor from a group. A distributor can belong to multiple groups (e.g. CP Performance is both a "Distributor" AND "National"). Switch dimension with the selector to edit region, type, or any custom dimension you've added.
        {dimension !== 'type' && (
          <> Only customers classified as <strong style={{color:T.text}}>Distributors</strong> (in the type dimension) appear here — Sundry, Excluded and Internal customers don't need a {dimension}.</>
        )}
      </div>
    </div>

    <div style={{background:T.bg2,border:`1px solid ${T.border}`,borderRadius:10,padding:16}}>
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
        <span style={{fontSize:11,color:T.text3}}>Dimension:</span>
        <select value={dimension} onChange={e=>setDimension(e.target.value)}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'4px 8px',fontSize:12,outline:'none'}}>
          {dims.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        {unassignedCount > 0 && (
          <span style={{fontSize:11,color:T.amber,padding:'3px 8px',borderRadius:4,background:`${T.amber}15`,border:`1px solid ${T.amber}40`,fontFamily:'monospace'}}>
            ⚠ {unassignedCount} unassigned
          </span>
        )}
        <div style={{flex:1}}/>
        <input placeholder="Search distributors…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{background:T.bg3,border:`1px solid ${T.border}`,color:T.text,borderRadius:4,padding:'5px 10px',fontSize:12,width:240,outline:'none'}}/>
      </div>

      <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr style={{borderBottom:`1px solid ${T.border2}`}}>
            <th style={{fontSize:10,color:T.text3,padding:'8px 10px',textAlign:'left',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em',position:'sticky',left:0,background:T.bg2}}>
              Distributor ({filtered.length}{dimension !== 'type' && filtered.length !== canonicalNames.length ? ` of ${canonicalNames.length}` : ''})
            </th>
            {groupsInDim.map(g => (
              <th key={g.id} style={{fontSize:10,padding:'8px 10px',textAlign:'center',fontWeight:500,textTransform:'uppercase',letterSpacing:'0.05em',color:g.color||T.text3,whiteSpace:'nowrap'}}>
                {g.name}
              </th>
            ))}
          </tr></thead>
          <tbody>{filtered.map(cn => {
            const unassigned = isUnassigned(cn)
            return (
            <tr key={cn} style={{
              borderTop:`1px solid ${T.border}`,
              outline: unassigned ? `1px solid ${T.amber}` : 'none',
              outlineOffset: unassigned ? '-1px' : 0,
              background: unassigned ? `${T.amber}08` : 'transparent',
            }}>
              <td style={{
                fontSize:12,padding:'6px 10px',position:'sticky',left:0,
                background: unassigned ? `${T.amber}08` : T.bg2,
                color: unassigned ? T.amber : T.text,
                fontWeight: unassigned ? 500 : 400,
              }}>
                {cn}
                {unassigned && <span style={{marginLeft:8,fontSize:10,color:T.amber,fontFamily:'monospace'}}>· not in any {dimension}</span>}
              </td>
              {groupsInDim.map(g => {
                const isMember = !!membersByGroup[g.id]?.has(cn)
                return <td key={g.id} style={{textAlign:'center',padding:'6px 10px'}}>
                  <input type="checkbox" checked={isMember}
                    onChange={()=>onToggle(g.id, cn, isMember)}
                    style={{cursor:'pointer',accentColor:g.color||T.blue}}/>
                </td>
              })}
            </tr>
          )})}</tbody>
        </table>
      </div>
    </div>
  </div>
}

export async function getServerSideProps(context: any) {
  return requirePageAuth(context, 'admin:settings')
}

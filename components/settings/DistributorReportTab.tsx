// components/settings/DistributorReportTab.tsx
// Admin-only settings for the Distributor Report: add/rename/remove revenue
// categories, check/uncheck which MYOB account codes belong in each, manage
// the excluded-customer list.

import { useState, useEffect, useCallback } from 'react'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', pink:'#ff5ac4',
  accent:'#4f8ef7',
}

interface Category {
  id?: string
  name: string
  sort_order: number
  account_codes: string[]
}
interface ExcludedCustomer {
  id?: string
  customer_name: string
  note?: string | null
}
interface MyobAccount {
  code: string
  name: string
}

// Fixed category colour palette for the top-of-category chip
const CAT_COLOURS = [T.blue, T.amber, T.green, T.purple, T.pink, T.teal, T.red]

export default function DistributorReportTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [dirty, setDirty] = useState(false)

  const [categories, setCategories] = useState<Category[]>([])
  const [excluded, setExcluded] = useState<ExcludedCustomer[]>([])
  const [myobAccounts, setMyobAccounts] = useState<MyobAccount[]>([])

  const [newExName, setNewExName] = useState('')
  const [newExNote, setNewExNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/distributor-config')
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Load failed' }))
        throw new Error(err.error || `HTTP ${r.status}`)
      }
      const d = await r.json()
      setCategories(d.categories || [])
      setExcluded(d.excludedCustomers || [])
      setMyobAccounts(d.myobAccounts || [])
      setDirty(false)
    } catch (e: any) {
      setError(e.message || 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load() }, [load])

  // Which codes are currently assigned to any category (used to warn on duplicates)
  const assigned = new Map<string, string>()
  for (const c of categories) for (const code of c.account_codes) assigned.set(code, c.name)

  function markDirty() { setDirty(true); setInfo('') }

  // Category operations
  function addCategory() {
    let n = 1
    while (categories.some(c => c.name.toLowerCase() === `new category ${n}`.toLowerCase())) n++
    setCategories([...categories, { name: `New Category ${n}`, sort_order: categories.length + 1, account_codes: [] }])
    markDirty()
  }
  function renameCategory(idx: number, newName: string) {
    const next = [...categories]
    next[idx] = { ...next[idx], name: newName }
    setCategories(next); markDirty()
  }
  function removeCategory(idx: number) {
    if (!confirm(`Remove category "${categories[idx].name}"? Account codes in it will become un-categorised and won't appear in the report.`)) return
    const next = categories.filter((_, i) => i !== idx).map((c, i) => ({ ...c, sort_order: i + 1 }))
    setCategories(next); markDirty()
  }
  function moveCategory(idx: number, dir: -1 | 1) {
    const target = idx + dir
    if (target < 0 || target >= categories.length) return
    const next = [...categories]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setCategories(next.map((c, i) => ({ ...c, sort_order: i + 1 })))
    markDirty()
  }
  function toggleCodeInCategory(catIdx: number, code: string, shouldBeIn: boolean) {
    const next = categories.map((c, i) => {
      if (i === catIdx) {
        const set = new Set(c.account_codes)
        if (shouldBeIn) set.add(code)
        else set.delete(code)
        return { ...c, account_codes: Array.from(set).sort() }
      } else if (shouldBeIn) {
        // Adding to this category — remove from any other category (codes can only be in one)
        return { ...c, account_codes: c.account_codes.filter(x => x !== code) }
      }
      return c
    })
    setCategories(next); markDirty()
  }

  // Excluded customer operations
  function addExcluded() {
    const name = newExName.trim()
    if (!name) return
    if (excluded.some(x => x.customer_name.toLowerCase() === name.toLowerCase())) {
      setError('That customer is already excluded'); return
    }
    setExcluded([...excluded, { customer_name: name, note: newExNote.trim() || null }].sort((a, b) => a.customer_name.localeCompare(b.customer_name)))
    setNewExName(''); setNewExNote(''); setError(''); markDirty()
  }
  function removeExcluded(idx: number) {
    setExcluded(excluded.filter((_, i) => i !== idx)); markDirty()
  }

  async function save() {
    setSaving(true); setError(''); setInfo('')
    try {
      const r = await fetch('/api/distributor-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categories, excludedCustomers: excluded }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Save failed' }))
        throw new Error(err.error || `HTTP ${r.status}`)
      }
      setDirty(false); setInfo('Saved. Changes take effect within 1 minute on the Distributor report.')
      // Reload fresh IDs/timestamps from server
      await load()
    } catch (e: any) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return (
    <div style={{padding:40, textAlign:'center', color:T.text3}}>
      <div style={{fontSize:24, animation:'spin 1s linear infinite'}}>⟳</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{marginTop:10}}>Loading config…</div>
    </div>
  )

  const uncategorisedAccounts = myobAccounts.filter(a => !assigned.has(a.code))

  return (
    <div style={{display:'flex', flexDirection:'column', gap:16, maxWidth:1100}}>
      <div>
        <h2 style={{margin:'0 0 6px', fontSize:18, fontWeight:600}}>Distributor Report configuration</h2>
        <p style={{margin:0, fontSize:13, color:T.text2, lineHeight:1.5}}>
          Controls which MYOB revenue accounts feed into the Distributor report and which customers are excluded.
          Account codes can only belong to one category. Changes take effect within ~60 seconds (report cache TTL).
        </p>
      </div>

      {error && <div style={{background:'rgba(240,78,78,0.1)', border:`1px solid ${T.red}40`, borderRadius:8, padding:'10px 14px', color:T.red, fontSize:13}}>{error}</div>}
      {info  && <div style={{background:'rgba(52,199,123,0.1)', border:`1px solid ${T.green}40`, borderRadius:8, padding:'10px 14px', color:T.green, fontSize:13}}>{info}</div>}

      {/* Categories */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:12, padding:20}}>
        <div style={{display:'flex', alignItems:'center', marginBottom:14, gap:12}}>
          <div style={{fontSize:13, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.08em'}}>Revenue Categories</div>
          <div style={{flex:1}}/>
          <button onClick={addCategory}
            style={{padding:'5px 12px', borderRadius:5, border:`1px solid ${T.accent}`, background:'transparent', color:T.accent, fontSize:11, fontFamily:'inherit', cursor:'pointer', fontWeight:600}}>
            + Add category
          </button>
        </div>

        {categories.map((cat, catIdx) => {
          const colour = CAT_COLOURS[catIdx % CAT_COLOURS.length]
          return (
            <div key={catIdx} style={{marginBottom:14, border:`1px solid ${T.border}`, borderRadius:8, padding:14, background:T.bg3}}>
              {/* Header row: name input + move/remove */}
              <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:12}}>
                <div style={{width:4, height:22, background:colour, borderRadius:2, flexShrink:0}}/>
                <input type="text" value={cat.name}
                  onChange={e => renameCategory(catIdx, e.target.value)}
                  style={{background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'6px 10px', fontSize:14, fontWeight:600, fontFamily:'inherit', outline:'none', minWidth:160}}
                />
                <span style={{fontSize:11, color:T.text3, fontFamily:'monospace'}}>
                  {cat.account_codes.length} {cat.account_codes.length === 1 ? 'code' : 'codes'}
                </span>
                <div style={{flex:1}}/>
                <button onClick={() => moveCategory(catIdx, -1)} disabled={catIdx === 0}
                  title="Move up" style={btnSm(T.text3, catIdx === 0)}>↑</button>
                <button onClick={() => moveCategory(catIdx, 1)} disabled={catIdx === categories.length - 1}
                  title="Move down" style={btnSm(T.text3, catIdx === categories.length - 1)}>↓</button>
                <button onClick={() => removeCategory(catIdx)} title="Remove category"
                  style={{...btnSm(T.red, false), borderColor:`${T.red}60`}}>✕</button>
              </div>

              {/* Account grid */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap:6}}>
                {myobAccounts.map(acc => {
                  const inThisCat = cat.account_codes.includes(acc.code)
                  const inOtherCat = assigned.get(acc.code)
                  const inOther = inOtherCat && inOtherCat !== cat.name
                  return (
                    <label key={acc.code}
                      title={inOther ? `Already assigned to "${inOtherCat}" — check to move here` : undefined}
                      style={{
                        display:'flex', alignItems:'center', gap:8,
                        padding:'6px 8px', borderRadius:5,
                        background: inThisCat ? `${colour}15` : 'transparent',
                        border:`1px solid ${inThisCat ? colour + '60' : T.border}`,
                        cursor:'pointer', fontSize:11,
                        opacity: inOther ? 0.55 : 1,
                      }}>
                      <input type="checkbox" checked={inThisCat}
                        onChange={e => toggleCodeInCategory(catIdx, acc.code, e.target.checked)}
                        style={{margin:0, cursor:'pointer'}}/>
                      <span style={{fontFamily:'monospace', color:inThisCat ? T.text : T.text2, flexShrink:0, minWidth:42}}>{acc.code}</span>
                      <span style={{color:T.text3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{acc.name}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Uncategorised accounts info */}
        {uncategorisedAccounts.length > 0 && (
          <div style={{marginTop:6, padding:'10px 12px', background:T.bg4, border:`1px dashed ${T.border2}`, borderRadius:6, fontSize:11, color:T.text3}}>
            <strong style={{color:T.text2}}>{uncategorisedAccounts.length} account{uncategorisedAccounts.length === 1 ? '' : 's'}</strong> not assigned to any category (will not appear in the report):
            {' '}{uncategorisedAccounts.map(a => a.code).join(', ')}
          </div>
        )}
      </div>

      {/* Excluded customers */}
      <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:12, padding:20}}>
        <div style={{fontSize:13, fontWeight:600, color:T.text3, textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:14}}>
          Excluded Customers
        </div>
        <p style={{margin:'0 0 12px', fontSize:12, color:T.text3, lineHeight:1.5}}>
          Invoices from these customers will be excluded from the Distributor report.
          Match is case-insensitive, exact-match on the MYOB CustomerName field (including
          before we strip the "(Tuning)", "(Tuning 1)", "(Tuning 2)" suffixes).
        </p>

        {/* Add form */}
        <div style={{display:'flex', gap:8, marginBottom:14, flexWrap:'wrap'}}>
          <input type="text" value={newExName} onChange={e => setNewExName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addExcluded() }}
            placeholder="Customer name (exact match)"
            style={{flex:1, minWidth:200, background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'7px 12px', fontSize:13, fontFamily:'inherit', outline:'none'}}/>
          <input type="text" value={newExNote} onChange={e => setNewExNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addExcluded() }}
            placeholder="Note (optional)"
            style={{flex:1, minWidth:180, background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, borderRadius:6, padding:'7px 12px', fontSize:13, fontFamily:'inherit', outline:'none'}}/>
          <button onClick={addExcluded} disabled={!newExName.trim()}
            style={{padding:'7px 14px', borderRadius:6, border:`1px solid ${T.accent}`, background: newExName.trim() ? T.accent : 'transparent', color: newExName.trim() ? '#fff' : T.text3, fontSize:12, fontFamily:'inherit', cursor: newExName.trim() ? 'pointer' : 'not-allowed', fontWeight:600}}>
            Add
          </button>
        </div>

        {/* List */}
        <div style={{display:'flex', flexDirection:'column', gap:4}}>
          {excluded.length === 0 && <div style={{color:T.text3, fontSize:12, padding:16, textAlign:'center'}}>No exclusions.</div>}
          {excluded.map((x, i) => (
            <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'6px 10px', background:T.bg3, borderRadius:5, border:`1px solid ${T.border}`}}>
              <span style={{fontSize:12, color:T.text, flex:1}}>{x.customer_name}</span>
              {x.note && <span style={{fontSize:11, color:T.text3, fontStyle:'italic'}}>{x.note}</span>}
              <button onClick={() => removeExcluded(i)} title="Remove"
                style={{background:'transparent', border:'none', color:T.text3, cursor:'pointer', fontSize:14, padding:'2px 6px', borderRadius:3}}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Save bar — sticky at bottom when dirty */}
      <div style={{display:'flex', gap:12, alignItems:'center', padding:'12px 0', borderTop:dirty?`1px solid ${T.amber}40`:'none', position:'sticky', bottom:0, background:T.bg, paddingTop:12, marginTop:4}}>
        {dirty && <span style={{fontSize:12, color:T.amber}}>● Unsaved changes</span>}
        <div style={{flex:1}}/>
        <button onClick={() => load()} disabled={saving || !dirty}
          style={{padding:'8px 16px', borderRadius:6, border:`1px solid ${T.border2}`, background:'transparent', color:T.text2, fontSize:12, fontFamily:'inherit', cursor: (saving || !dirty) ? 'not-allowed' : 'pointer', opacity: dirty ? 1 : 0.4}}>
          Discard
        </button>
        <button onClick={save} disabled={saving || !dirty}
          style={{padding:'8px 20px', borderRadius:6, border:'none', background: dirty ? T.accent : T.bg3, color: dirty ? '#fff' : T.text3, fontSize:13, fontFamily:'inherit', cursor: (saving || !dirty) ? 'not-allowed' : 'pointer', fontWeight:600}}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

function btnSm(color: string, disabled: boolean): React.CSSProperties {
  return {
    padding:'4px 8px', borderRadius:4, border:`1px solid ${T.border2}`,
    background:'transparent', color, fontSize:11, fontFamily:'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1, minWidth:28,
  }
}

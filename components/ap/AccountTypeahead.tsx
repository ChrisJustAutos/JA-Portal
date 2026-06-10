// components/ap/AccountTypeahead.tsx
// MYOB account search typeahead (extracted from pages/ap/[id].tsx).
//
// Two changes in May 2026:
//
// 1. PRE-PICKED NAME HYDRATION
//    SupplierPresetForm seeds `selected` from the invoice's
//    resolved_account_uid + resolved_account_code. The invoice doesn't
//    store the account name — there's no resolved_account_name column —
//    so the seed has `name: ''`. The closed-state display showed only
//    "6-1174" until the user re-selected. Fix: track an internal
//    `displaySelected` state that mirrors `selected` but, when the name
//    is empty, fires a one-shot fetch via /api/myob/accounts?q=<displayId>
//    to find the matching entry and enrich `name` (and type / parent /
//    isHeader). We DON'T call onSelect with the enriched account —
//    parent state stays as-is until the user actually changes the pick.
//
// 2. RESULT LIMIT + LIST HEIGHT
//    Frontend was asking for 40 rows; bumped to 100 (server's hard cap).
//    Container maxHeight 380px → 480px so users see ~16 rows at once.

import { useState, useEffect } from 'react'
import { T } from '../../lib/ui/theme'
import { MyobAccount, btnSecondary, inputStyle } from './shared'

export function AccountTypeahead({
  companyFile, selected, onSelect, forceOpen, placeholder,
}: {
  companyFile: 'VPS' | 'JAWS'
  selected: MyobAccount | null
  onSelect: (a: MyobAccount | null) => void
  forceOpen?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(!!forceOpen)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<MyobAccount[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)

  // Display copy of `selected` — same data, but with the name hydrated
  // when the upstream caller couldn't supply it.
  const [displaySelected, setDisplaySelected] = useState<MyobAccount | null>(selected)

  // Re-sync if the parent's selected prop changes (e.g. user picks a
  // different account in this typeahead, parent re-renders us).
  useEffect(() => {
    setDisplaySelected(selected)
  }, [selected?.uid, selected?.displayId, selected?.name])

  // Hydrate the name when it's missing. Searches /api/myob/accounts by
  // the displayId and finds the exact match. Fails silently — if the
  // lookup errors out, we keep showing just the code (pre-fix behaviour).
  useEffect(() => {
    if (!selected || !selected.uid || !selected.displayId) return
    if (selected.name) return
    let cancelled = false
    ;(async () => {
      try {
        const params = new URLSearchParams({
          q: selected.displayId, company: companyFile, limit: '5',
        })
        const res = await fetch(`/api/myob/accounts?${params.toString()}`, { credentials: 'same-origin' })
        if (!res.ok) return
        const json = await res.json()
        const accounts: MyobAccount[] = Array.isArray(json.accounts) ? json.accounts : []
        const match = accounts.find(a => a.displayId === selected.displayId) || null
        if (match && !cancelled) {
          setDisplaySelected({
            ...selected,
            name:       match.name,
            type:       match.type       || selected.type,
            parentName: match.parentName ?? selected.parentName,
            isHeader:   match.isHeader,
          })
        }
      } catch {
        // swallow — falls back to just the code in the closed state
      }
    })()
    return () => { cancelled = true }
  }, [selected?.uid, selected?.displayId, selected?.name, companyFile])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        // limit 100 = server's hard cap. Combined with maxHeight 480px
        // below, this surfaces ~16 rows on screen at once.
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '100' })
        const res = await fetch(`/api/myob/accounts?${params.toString()}`, { credentials: 'same-origin' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResults(Array.isArray(json.accounts) ? json.accounts : [])
      } catch (e: any) {
        setSearchError(e?.message || 'search failed')
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [open, query, companyFile])

  if (!open) {
    return (
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <div style={{flex:1, fontSize:12, color: displaySelected ? T.text : T.text3, minWidth:0}}>
          {displaySelected ? (
            <>
              <span style={{fontFamily:'monospace'}}>{displaySelected.displayId}</span>
              {displaySelected.name && <span style={{marginLeft:8, color:T.text2}}>{displaySelected.name}</span>}
            </>
          ) : 'No account picked'}
        </div>
        <button onClick={() => setOpen(true)} style={btnSecondary()}>{displaySelected ? 'Change…' : 'Search MYOB…'}</button>
        {displaySelected && (
          <button onClick={() => onSelect(null)} style={btnSecondary()}>Clear</button>
        )}
      </div>
    )
  }

  return (
    <div>
      <div style={{display:'flex', gap:8, marginBottom:8}}>
        <input
          autoFocus
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={placeholder || "Search by code or name (any account type)…"}
          style={inputStyle()}
        />
        {!forceOpen && (
          <button onClick={() => setOpen(false)} style={btnSecondary()}>Close</button>
        )}
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:480, overflowY:'auto', background: T.bg3,
      }}>
        {loading && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching MYOB…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
            {query ? 'No matching accounts.' : 'Showing top accounts. Refine with a query.'}
          </div>
        )}
        {!loading && results.map((a, i) => (
          <div
            key={a.uid}
            onClick={() => { onSelect(a); if (!forceOpen) setOpen(false) }}
            style={{
              padding:'10px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'80px 1fr 110px', gap:10, alignItems:'center',
            }}
          >
            <span style={{fontFamily:'monospace', color:T.text}}>{a.displayId}</span>
            <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.name}</span>
            <span style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.04em', textAlign:'right'}}>{a.type}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

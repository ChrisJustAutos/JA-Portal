// components/settings/PaymentAccountsManager.tsx
// Admin UI for the ap_payment_accounts list — the clearing accounts the
// AP detail page offers when "Mark as paid" is ticked. Mounted inside
// MyobTab below the connections list.
//
// Each row: label, MYOB account picker, Capricorn-default flag, active
// toggle, sort order, delete. Per-company-file (VPS / JAWS).

import { useCallback, useEffect, useState } from 'react'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa', accent:'#4f8ef7',
}

type CompanyFileLabel = 'VPS' | 'JAWS'

interface PaymentAccount {
  id: string
  myob_company_file: CompanyFileLabel
  label: string
  account_uid: string
  account_code: string
  account_name: string
  is_default_for_capricorn: boolean
  is_active: boolean
  sort_order: number
}

interface MyobAccount {
  uid: string
  displayId: string
  name: string
  type: string
}

export default function PaymentAccountsManager() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [addOpenFor, setAddOpenFor] = useState<CompanyFileLabel | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/ap/payment-accounts')
      if (!r.ok) throw new Error((await r.json()).error || 'Load failed')
      const d = await r.json()
      setAccounts(d.accounts || [])
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  async function patch(id: string, body: Partial<PaymentAccount>) {
    setBusy(id); setError('')
    try {
      const r = await fetch(`/api/ap/payment-accounts?id=${id}`, {
        method: 'PATCH', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Update failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function del(id: string, label: string) {
    if (!confirm(`Delete payment account "${label}"?`)) return
    setBusy(id); setError('')
    try {
      const r = await fetch(`/api/ap/payment-accounts?id=${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || 'Delete failed')
      await load()
    } catch (e: any) { setError(e.message) }
    finally { setBusy(null) }
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:18}}>
      <div style={{fontSize:13, fontWeight:600, color:T.text, marginBottom:4}}>
        Payment clearing accounts
      </div>
      <div style={{fontSize:12, color:T.text3, marginBottom:14, lineHeight:1.5}}>
        When approving an AP invoice with "Mark as paid" ticked, a Purchase Payment is applied
        from one of these accounts immediately after the bill posts to MYOB. Capricorn-routed invoices
        auto-tick if a Capricorn-default account is configured.
      </div>

      {error && <div style={{marginBottom:12, padding:10, background:`${T.red}15`, color:T.red, fontSize:12, borderRadius:6, border:`1px solid ${T.red}40`}}>{error}</div>}

      {loading && <div style={{color:T.text3, fontSize:12, padding:'10px 0'}}>Loading…</div>}

      {!loading && (['VPS','JAWS'] as CompanyFileLabel[]).map(cf => {
        const rows = accounts.filter(a => a.myob_company_file === cf).sort((a, b) => a.sort_order - b.sort_order)
        return (
          <div key={cf} style={{marginBottom:18}}>
            <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:8}}>
              <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
                {cf} ({rows.length})
              </div>
              <div style={{flex:1, height:1, background:T.border}}/>
              <button
                onClick={() => setAddOpenFor(addOpenFor === cf ? null : cf)}
                style={{
                  padding:'4px 10px', borderRadius:4, border:`1px solid ${T.border2}`,
                  background:'transparent', color: T.blue, fontSize:11, cursor:'pointer',
                  fontFamily:'inherit',
                }}>
                {addOpenFor === cf ? 'Cancel' : '+ Add account'}
              </button>
            </div>

            {addOpenFor === cf && (
              <AddRow
                companyFile={cf}
                onClose={() => setAddOpenFor(null)}
                onSaved={() => { setAddOpenFor(null); void load() }}
              />
            )}

            {rows.length === 0 && addOpenFor !== cf && (
              <div style={{fontSize:12, color:T.text3, padding:'10px 0'}}>None configured.</div>
            )}

            {rows.map(a => (
              <div key={a.id} style={{
                display:'grid',
                gridTemplateColumns: '160px 1fr 110px 110px 70px',
                gap:10, alignItems:'center',
                padding:'8px 10px',
                background: T.bg3,
                border: `1px solid ${a.is_default_for_capricorn ? T.amber + '40' : T.border}`,
                borderRadius:6, marginBottom:6,
              }}>
                <div>
                  <input
                    type="text"
                    defaultValue={a.label}
                    onBlur={e => { if (e.target.value.trim() !== a.label) patch(a.id, { label: e.target.value.trim() }) }}
                    disabled={busy === a.id}
                    style={{width:'100%', boxSizing:'border-box', padding:'5px 8px', background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:4, fontSize:12, fontFamily:'inherit', outline:'none'}}
                  />
                </div>
                <div style={{minWidth:0}}>
                  <span style={{fontFamily:'monospace', color:T.text}}>{a.account_code}</span>
                  <span style={{color:T.text3, marginLeft:8}}>{a.account_name}</span>
                </div>
                <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:11, color:T.text2}}>
                  <input type="checkbox" checked={a.is_default_for_capricorn}
                    disabled={busy === a.id}
                    onChange={e => patch(a.id, { is_default_for_capricorn: e.target.checked })}/>
                  Cap default
                </label>
                <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:11, color: a.is_active ? T.green : T.text3}}>
                  <input type="checkbox" checked={a.is_active}
                    disabled={busy === a.id}
                    onChange={e => patch(a.id, { is_active: e.target.checked })}/>
                  {a.is_active ? 'Active' : 'Inactive'}
                </label>
                <button
                  onClick={() => del(a.id, a.label)}
                  disabled={busy === a.id}
                  style={{padding:'4px 10px', borderRadius:4, border:'none', background:'transparent', color:T.red, fontSize:11, cursor:'pointer', fontFamily:'inherit'}}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// ── Add-row form ─────────────────────────────────────────────────────────

function AddRow({ companyFile, onClose, onSaved }: {
  companyFile: CompanyFileLabel
  onClose: () => void
  onSaved: () => void
}) {
  const [label, setLabel] = useState('')
  const [picked, setPicked] = useState<MyobAccount | null>(null)
  const [isCapDefault, setIsCapDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MyobAccount[]>([])
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    if (!searchOpen) return
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '40' })
        const r = await fetch(`/api/myob/accounts?${params.toString()}`)
        const j = await r.json()
        if (r.ok) setResults(Array.isArray(j.accounts) ? j.accounts : [])
        else setResults([])
      } catch { setResults([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [query, companyFile, searchOpen])

  async function save() {
    if (!label.trim()) { setErr('Label is required'); return }
    if (!picked)        { setErr('Pick a MYOB account'); return }
    setSaving(true); setErr('')
    try {
      const r = await fetch('/api/ap/payment-accounts', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          myob_company_file: companyFile,
          label: label.trim(),
          account_uid:  picked.uid,
          account_code: picked.displayId,
          account_name: picked.name,
          is_default_for_capricorn: isCapDefault,
          is_active: true,
          sort_order: 0,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Save failed')
      onSaved()
    } catch (e: any) { setErr(e.message) }
    finally { setSaving(false) }
  }

  return (
    <div style={{padding:12, background:T.bg3, border:`1px solid ${T.border2}`, borderRadius:6, marginBottom:8}}>
      <div style={{display:'grid', gridTemplateColumns:'160px 1fr', gap:10, marginBottom:10}}>
        <div>
          <div style={{fontSize:10, color:T.text3, marginBottom:4, textTransform:'uppercase', letterSpacing:'0.05em'}}>Label</div>
          <input
            autoFocus value={label} onChange={e => setLabel(e.target.value)}
            placeholder="Capricorn"
            style={{width:'100%', boxSizing:'border-box', padding:'7px 10px', background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:4, fontSize:12, fontFamily:'inherit', outline:'none'}}
          />
        </div>
        <div>
          <div style={{fontSize:10, color:T.text3, marginBottom:4, textTransform:'uppercase', letterSpacing:'0.05em'}}>MYOB account</div>
          {!searchOpen && picked && (
            <div style={{display:'flex', gap:8, alignItems:'center'}}>
              <span style={{fontFamily:'monospace', color:T.text, fontSize:12}}>{picked.displayId}</span>
              <span style={{color:T.text3, fontSize:12}}>{picked.name}</span>
              <button onClick={() => setSearchOpen(true)} style={btn()}>Change</button>
            </div>
          )}
          {!searchOpen && !picked && (
            <button onClick={() => setSearchOpen(true)} style={btn()}>Search MYOB…</button>
          )}
          {searchOpen && (
            <div>
              <input
                autoFocus value={query} onChange={e => setQuery(e.target.value)}
                placeholder="search account name or code…"
                style={{width:'100%', boxSizing:'border-box', padding:'7px 10px', background:T.bg4, border:`1px solid ${T.border2}`, color:T.text, borderRadius:4, fontSize:12, fontFamily:'inherit', outline:'none', marginBottom:6}}
              />
              <div style={{maxHeight:200, overflowY:'auto', border:`1px solid ${T.border}`, borderRadius:4, background:T.bg4}}>
                {results.length === 0 && (
                  <div style={{padding:10, fontSize:11, color:T.text3, textAlign:'center'}}>
                    {query ? 'No matches.' : 'Type to search…'}
                  </div>
                )}
                {results.map(a => (
                  <div key={a.uid}
                    onClick={() => { setPicked(a); setSearchOpen(false); setQuery('') }}
                    style={{padding:'8px 10px', borderTop:`1px solid ${T.border}`, cursor:'pointer', fontSize:12, display:'grid', gridTemplateColumns:'80px 1fr 80px', gap:8}}>
                    <span style={{fontFamily:'monospace', color:T.text}}>{a.displayId}</span>
                    <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{a.name}</span>
                    <span style={{fontSize:10, color:T.text3, textAlign:'right'}}>{a.type}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => setSearchOpen(false)} style={{...btn(), marginTop:6}}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      <label style={{display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontSize:11, color:T.text2, marginBottom:10}}>
        <input type="checkbox" checked={isCapDefault} onChange={e => setIsCapDefault(e.target.checked)}/>
        Default for Capricorn-routed invoices
      </label>

      {err && <div style={{fontSize:11, color:T.red, marginBottom:8}}>{err}</div>}

      <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
        <button onClick={onClose} disabled={saving} style={btn()}>Cancel</button>
        <button onClick={save} disabled={saving || !label.trim() || !picked}
          style={{...btn(), background: saving || !picked ? T.bg4 : T.green, color: saving || !picked ? T.text3 : '#fff', borderColor: T.green, fontWeight:600}}>
          {saving ? 'Saving…' : 'Add'}
        </button>
      </div>
    </div>
  )
}

function btn(): React.CSSProperties {
  return {
    padding:'5px 12px', borderRadius:4, border:`1px solid ${T.border2}`,
    background:'transparent', color:T.text, fontSize:11, cursor:'pointer',
    fontFamily:'inherit',
  }
}

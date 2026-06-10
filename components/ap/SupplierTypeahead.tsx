// components/ap/SupplierTypeahead.tsx
// MYOB supplier search + inline "create new supplier card" form
// (extracted from pages/ap/[id].tsx).

import { useState, useEffect } from 'react'
import { T } from '../../lib/ui/theme'
import { MyobSupplier, btnSecondary, inputStyle } from './shared'
import { FormRow } from './Primitives'

export function SupplierTypeahead({
  companyFile, selected, onSelect, initialQuery, createFrom,
}: {
  companyFile: 'VPS' | 'JAWS'
  selected: MyobSupplier | null
  onSelect: (s: MyobSupplier | null) => void
  initialQuery?: string
  /** When provided, surfaces a "Create new MYOB supplier" button in the
   *  picker that POSTs the supplied fields (no bank/payment details) and
   *  auto-selects the new card. Used on the AP detail page so editors
   *  can mint a card straight from the parsed invoice header. The fields
   *  beyond name + ABN are pulled from the AI extraction (lib/ap-extraction)
   *  and pre-fill the inline form. */
  createFrom?: {
    vendorName: string | null
    vendorAbn:  string | null
    email?:    string | null
    phone?:    string | null
    website?:  string | null
    street?:   string | null
    city?:     string | null
    state?:    string | null
    postcode?: string | null
    country?:  string | null
    /** Suggested default tax code for the new supplier card. The AP detail
     *  page derives this from the invoice's GST signals (gst_amount + per
     *  line tax_code) so a no-GST invoice (bank, payroll, etc) starts the
     *  form on FRE. The user can still flip it before saving. */
    suggestedTaxCode?: 'GST' | 'FRE'
    /** Short human-readable explanation of why suggestedTaxCode was picked
     *  (e.g. "Invoice shows $25.50 GST"). Rendered as a hint under the
     *  GST/FRE toggle so the choice is auditable. */
    taxCodeReason?: string
  }
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(initialQuery || '')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<MyobSupplier[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '', abn: '',
    email: '', phone: '', website: '',
    street: '', city: '', state: '', postcode: '', country: 'Australia',
    taxCode: 'GST' as 'GST' | 'FRE',
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  function startCreate() {
    setCreateForm({
      name:     (createFrom?.vendorName || query || '').trim(),
      abn:      (createFrom?.vendorAbn || '').trim(),
      email:    (createFrom?.email    || '').trim(),
      phone:    (createFrom?.phone    || '').trim(),
      website:  (createFrom?.website  || '').trim(),
      street:   (createFrom?.street   || '').trim(),
      city:     (createFrom?.city     || '').trim(),
      state:    (createFrom?.state    || '').trim(),
      postcode: (createFrom?.postcode || '').trim(),
      country:  (createFrom?.country  || 'Australia').trim(),
      taxCode:  createFrom?.suggestedTaxCode || 'GST',
    })
    setCreateError(null)
    setCreateOpen(true)
  }

  function setCreateField<K extends keyof typeof createForm>(key: K, value: string) {
    setCreateForm(f => ({ ...f, [key]: value }))
  }

  async function submitCreate() {
    const name = createForm.name.trim()
    if (!name) { setCreateError('Company name is required'); return }
    const abn = createForm.abn.replace(/\s/g, '').trim()
    if (abn && !/^\d{11}$/.test(abn)) { setCreateError('ABN must be 11 digits'); return }
    const email = createForm.email.trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setCreateError('Email is not a valid address'); return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const res = await fetch('/api/myob/suppliers', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: companyFile,
          companyName: name,
          abn: abn || null,
          taxCode:  createForm.taxCode,
          email:    email || null,
          phone:    createForm.phone.trim()    || null,
          website:  createForm.website.trim()  || null,
          street:   createForm.street.trim()   || null,
          city:     createForm.city.trim()     || null,
          state:    createForm.state.trim()    || null,
          postcode: createForm.postcode.trim() || null,
          country:  createForm.country.trim()  || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      onSelect(json.supplier)
      setCreateOpen(false)
      setOpen(false)
    } catch (e: any) {
      setCreateError(e?.message || 'create failed')
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSearchError(null)
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, company: companyFile, limit: '20' })
        const res = await fetch(`/api/myob/suppliers?${params.toString()}`, { credentials: 'same-origin' })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResults(Array.isArray(json.suppliers) ? json.suppliers : [])
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
        <div style={{flex:1, fontSize:12, color: selected ? T.text : T.text3, minWidth:0}}>
          {selected ? selected.name : 'No supplier picked'}
          {selected?.abn && <span style={{color:T.text3, marginLeft:8, fontFamily:'monospace'}}>ABN {selected.abn}</span>}
        </div>
        <button onClick={() => setOpen(true)} style={btnSecondary()}>{selected ? 'Change…' : 'Search MYOB…'}</button>
        {selected && (
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
          placeholder="Search MYOB suppliers…"
          style={inputStyle()}
        />
        <button onClick={() => setOpen(false)} style={btnSecondary()}>Close</button>
      </div>
      {searchError && (
        <div style={{fontSize:11, color:T.red, marginBottom:8}}>MYOB error: {searchError}</div>
      )}
      <div style={{
        border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
        maxHeight:240, overflowY:'auto', background: T.bg3,
      }}>
        {loading && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching MYOB…</div>
        )}
        {!loading && results.length === 0 && (
          <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
            {query ? 'No matching suppliers in MYOB.' : 'Type to search…'}
          </div>
        )}
        {!loading && results.map((s, i) => (
          <div
            key={s.uid}
            onClick={() => { onSelect(s); setOpen(false) }}
            style={{
              padding:'10px 12px',
              borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
              cursor:'pointer',
              fontSize: 12,
              display:'grid', gridTemplateColumns:'1fr auto', gap:10, alignItems:'center',
            }}
          >
            <div>
              <div style={{color:T.text}}>{s.name}</div>
              {s.abn && <div style={{fontSize:10, fontFamily:'monospace', color:T.text3, marginTop:2}}>ABN {s.abn}</div>}
            </div>
            {s.displayId && (
              <span style={{fontSize:10, color:T.text3, fontFamily:'monospace'}}>{s.displayId}</span>
            )}
          </div>
        ))}
      </div>

      {createFrom && !createOpen && (
        <div style={{marginTop:10, paddingTop:10, borderTop:`1px solid ${T.border}`}}>
          <button onClick={startCreate} style={{
            ...btnSecondary(),
            color: T.green, borderColor: `${T.green}40`,
          }}>
            + Create new MYOB supplier{createFrom.vendorName ? ` ("${createFrom.vendorName}")` : ''}
          </button>
          <div style={{fontSize:10, color:T.text3, marginTop:6, lineHeight:1.5}}>
            Writes Company name + ABN only. Bank/payment details, addresses and the default expense account stay manual in MYOB.
          </div>
        </div>
      )}

      {createFrom && createOpen && (
        <div style={{
          marginTop:10, padding:14, borderRadius:6,
          border:`1px solid ${T.green}40`, background: `${T.green}08`,
        }}>
          <div style={{fontSize:11, color:T.text2, marginBottom:10, fontWeight:600}}>
            Create new MYOB supplier in {companyFile}
          </div>

          {/* ── Identity ────────────────────────────────────────────── */}
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            <FormRow label="Company name *">
              <input
                autoFocus
                value={createForm.name}
                onChange={e => setCreateField('name', e.target.value)}
                placeholder="ACME Pty Ltd"
                style={inputStyle()}
              />
            </FormRow>
            <FormRow label="ABN (11 digits)">
              <input
                value={createForm.abn}
                onChange={e => setCreateField('abn', e.target.value)}
                placeholder="12345678901"
                style={inputStyle()}
              />
            </FormRow>
            <FormRow label="Default purchase tax code">
              <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                {(['GST', 'FRE'] as const).map(code => {
                  const on = createForm.taxCode === code
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setCreateField('taxCode', code)}
                      style={{
                        padding:'6px 14px',
                        borderRadius:5,
                        border:`1px solid ${on ? T.green : T.border2}`,
                        background: on ? `${T.green}20` : T.bg3,
                        color: on ? T.green : T.text,
                        fontSize:12, fontFamily:'inherit', fontWeight: on ? 600 : 400,
                        cursor:'pointer', minWidth:80,
                      }}>
                      {code === 'GST' ? 'GST (10%)' : 'FRE (no GST)'}
                    </button>
                  )
                })}
              </div>
              {createFrom?.taxCodeReason && (
                <div style={{fontSize:10, color:T.text3, marginTop:4, lineHeight:1.4}}>
                  Suggested from invoice: {createFrom.taxCodeReason}
                </div>
              )}
            </FormRow>
          </div>

          {/* ── Contact ─────────────────────────────────────────────── */}
          <div style={{
            marginTop:12, paddingTop:10, borderTop:`1px solid ${T.border}`,
            display:'flex', flexDirection:'column', gap:8,
          }}>
            <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
              Contact
            </div>
            <FormRow label="Email">
              <input
                type="email"
                value={createForm.email}
                onChange={e => setCreateField('email', e.target.value)}
                placeholder="accounts@acme.com.au"
                style={inputStyle()}
              />
            </FormRow>
            <FormRow label="Phone">
              <input
                value={createForm.phone}
                onChange={e => setCreateField('phone', e.target.value)}
                placeholder="(07) 1234 5678"
                style={inputStyle()}
              />
            </FormRow>
            <FormRow label="Website">
              <input
                value={createForm.website}
                onChange={e => setCreateField('website', e.target.value)}
                placeholder="https://acme.com.au"
                style={inputStyle()}
              />
            </FormRow>
          </div>

          {/* ── Address ─────────────────────────────────────────────── */}
          <div style={{
            marginTop:12, paddingTop:10, borderTop:`1px solid ${T.border}`,
            display:'flex', flexDirection:'column', gap:8,
          }}>
            <div style={{fontSize:10, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', fontWeight:600}}>
              Address
            </div>
            <FormRow label="Street">
              <textarea
                value={createForm.street}
                onChange={e => setCreateField('street', e.target.value)}
                placeholder={'123 Example St\nSuite 4'}
                rows={2}
                style={{...inputStyle(), resize:'vertical', minHeight:46, fontFamily:'inherit'}}
              />
            </FormRow>
            <div style={{display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:8}}>
              <FormRow label="Suburb">
                <input
                  value={createForm.city}
                  onChange={e => setCreateField('city', e.target.value)}
                  placeholder="Brisbane"
                  style={inputStyle()}
                />
              </FormRow>
              <FormRow label="State">
                <input
                  value={createForm.state}
                  onChange={e => setCreateField('state', e.target.value.toUpperCase())}
                  placeholder="QLD"
                  style={inputStyle()}
                />
              </FormRow>
              <FormRow label="Postcode">
                <input
                  value={createForm.postcode}
                  onChange={e => setCreateField('postcode', e.target.value)}
                  placeholder="4000"
                  style={inputStyle()}
                />
              </FormRow>
            </div>
            <FormRow label="Country">
              <input
                value={createForm.country}
                onChange={e => setCreateField('country', e.target.value)}
                placeholder="Australia"
                style={inputStyle()}
              />
            </FormRow>
          </div>

          <div style={{fontSize:10, color:T.text3, marginTop:10, lineHeight:1.5}}>
            Bank/payment details and the default expense account are not written here — set those in MYOB.
          </div>

          {createError && (
            <div style={{fontSize:11, color:T.red, marginTop:8}}>{createError}</div>
          )}
          <div style={{display:'flex', gap:8, marginTop:12, justifyContent:'flex-end'}}>
            <button onClick={() => setCreateOpen(false)} disabled={creating} style={btnSecondary()}>
              Cancel
            </button>
            <button onClick={submitCreate} disabled={creating || !createForm.name.trim()} style={{
              ...btnSecondary(),
              background: creating || !createForm.name.trim() ? T.bg3 : T.green,
              color: creating || !createForm.name.trim() ? T.text3 : '#fff',
              borderColor: creating || !createForm.name.trim() ? T.border2 : T.green,
              fontWeight: 600,
            }}>
              {creating ? 'Creating…' : 'Create in MYOB'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

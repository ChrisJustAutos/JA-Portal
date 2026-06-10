// components/ap/AccountPickerModal.tsx
// Per-line MYOB account picker with a "Save as rule for {supplier}"
// affordance (extracted from pages/ap/[id].tsx — Round 6 smart line→account
// pickup A+B).

import { useState } from 'react'
import { T } from '../../lib/ui/theme'
import { MyobAccount, btnSecondary, inputStyle } from './shared'
import { FormRow } from './Primitives'
import { AccountTypeahead } from './AccountTypeahead'

export function AccountPickerModal({
  companyFile, currentAccountCode, currentAccountName, invoiceDefaultCode,
  lineLabel, lineDescription, linePartNumber,
  supplier,
  onClose, onSelect,
}: {
  companyFile: 'VPS' | 'JAWS'
  currentAccountCode: string | null
  currentAccountName: string | null
  invoiceDefaultCode: string | null
  lineLabel: string
  lineDescription: string
  linePartNumber: string | null
  supplier: { uid: string; name: string } | null
  onClose: () => void
  onSelect: (account: MyobAccount | null) => void
}) {
  const [saveAsRule, setSaveAsRule] = useState(false)
  const [pattern, setPattern] = useState<string>(defaultPatternFor(lineDescription, linePartNumber))
  const [matchType, setMatchType] = useState<'contains' | 'starts_with' | 'exact'>('contains')
  const [matchField, setMatchField] = useState<'description' | 'part_number' | 'both'>('description')
  const [savingRule, setSavingRule] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)

  async function handleAccountClick(account: MyobAccount) {
    if (saveAsRule && supplier) {
      const trimmedPattern = pattern.trim()
      if (!trimmedPattern) {
        setRuleError('Pattern is required')
        return
      }
      setSavingRule(true)
      setRuleError(null)
      try {
        const res = await fetch('/api/ap/line-rules', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            supplier_uid:      supplier.uid,
            supplier_name:     supplier.name,
            myob_company_file: companyFile,
            pattern:           trimmedPattern,
            match_type:        matchType,
            match_field:       matchField,
            account_uid:       account.uid,
            account_code:      account.displayId,
            account_name:      account.name || account.displayId,
          }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      } catch (e: any) {
        setRuleError(`Rule save failed: ${e?.message || e}`)
        setSavingRule(false)
        return
      }
      setSavingRule(false)
    }
    onSelect(account)
  }

  return (
    <div
      onClick={onClose}
      style={{
        position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
        display:'flex', alignItems:'flex-start', justifyContent:'center',
        zIndex:1000, paddingTop:'8vh',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: T.bg2,
          border: `1px solid ${T.border2}`,
          borderRadius: 10,
          width: 'min(680px, 92vw)',
          padding: '18px 20px',
          maxHeight: '84vh',
          overflowY: 'auto',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', marginBottom:12}}>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:3}}>
              Pick account ({companyFile})
            </div>
            <div style={{fontSize:13, color:T.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{lineLabel}</div>
          </div>
          <button onClick={onClose} style={btnSecondary()}>Close</button>
        </div>

        <div style={{
          padding:'8px 10px', background:T.bg3, borderRadius:6, fontSize:11,
          color:T.text2, marginBottom:12,
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, flexWrap:'wrap',
        }}>
          <div>
            Current:{' '}
            {currentAccountCode ? (
              <span style={{fontFamily:'monospace', color:T.text}}>
                {currentAccountCode}
                {currentAccountName ? <span style={{color:T.text3}}> · {currentAccountName}</span> : null}
              </span>
            ) : (
              <span style={{color:T.text3}}>
                Default ({invoiceDefaultCode ? <span style={{fontFamily:'monospace'}}>{invoiceDefaultCode}</span> : 'none'})
              </span>
            )}
          </div>
          {currentAccountCode && (
            <button
              onClick={() => onSelect(null)}
              style={{
                ...btnSecondary(),
                color: T.amber,
                borderColor: `${T.amber}40`,
              }}
            >
              Reset to default
            </button>
          )}
        </div>

        {supplier && (
          <div style={{
            marginBottom:12, padding:'10px 12px',
            background:T.bg3, border:`1px solid ${T.border}`, borderRadius:6,
          }}>
            <label style={{display:'flex', alignItems:'center', gap:8, fontSize:12, color:T.text2, cursor:'pointer'}}>
              <input
                type="checkbox"
                checked={saveAsRule}
                onChange={e => setSaveAsRule(e.target.checked)}
                disabled={savingRule}
                style={{width:18, height:18}}
              />
              <span>Save as rule for <span style={{color:T.text}}>{supplier.name}</span></span>
            </label>
            {saveAsRule && (
              <div style={{marginTop:10, display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:8, alignItems:'end'}}>
                <FormRow label="Pattern">
                  <input
                    value={pattern}
                    onChange={e => setPattern(e.target.value)}
                    placeholder="brake pad"
                    style={inputStyle()}
                    disabled={savingRule}
                  />
                </FormRow>
                <FormRow label="Match">
                  <select
                    value={matchType}
                    onChange={e => setMatchType(e.target.value as any)}
                    disabled={savingRule}
                    style={{...inputStyle(), padding:'7px 8px'}}
                  >
                    <option value="contains">contains</option>
                    <option value="starts_with">starts with</option>
                    <option value="exact">exact</option>
                  </select>
                </FormRow>
                <FormRow label="Field">
                  <select
                    value={matchField}
                    onChange={e => setMatchField(e.target.value as any)}
                    disabled={savingRule}
                    style={{...inputStyle(), padding:'7px 8px'}}
                  >
                    <option value="description">description</option>
                    <option value="part_number">part number</option>
                    <option value="both">both</option>
                  </select>
                </FormRow>
              </div>
            )}
            {ruleError && (
              <div style={{marginTop:8, fontSize:11, color:T.red}}>{ruleError}</div>
            )}
          </div>
        )}

        <AccountTypeahead
          companyFile={companyFile}
          selected={null}
          onSelect={(a) => { if (a) handleAccountClick(a) }}
          forceOpen
          placeholder="Search any account by code or name…"
        />

        {savingRule && (
          <div style={{marginTop:10, fontSize:11, color:T.text3}}>Saving rule…</div>
        )}
      </div>
    </div>
  )
}

function defaultPatternFor(description: string, partNumber: string | null): string {
  const desc = (description || '').trim()
  if (desc) {
    return desc.split(/\s+/).slice(0, 2).join(' ').toLowerCase()
  }
  if (partNumber) return partNumber.trim().toLowerCase()
  return ''
}

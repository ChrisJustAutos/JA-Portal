// components/ap/MyobMappingSection.tsx
// MYOB supplier/account mapping card + the supplier-preset form
// (extracted from pages/ap/[id].tsx).

import { useState } from 'react'
import { T } from '../../lib/ui/theme'
import { InvoiceRow, MyobSupplier, MyobAccount, btnPrimary, btnSecondary, inputStyle } from './shared'
import { FormRow, Field } from './Primitives'
import { SupplierTypeahead } from './SupplierTypeahead'
import { AccountTypeahead } from './AccountTypeahead'

export function MyobMappingSection({
  invoice, canEdit, presetOpen, onOpenPreset, onClosePreset, onPresetSaved,
}: {
  invoice: InvoiceRow
  canEdit: boolean
  presetOpen: boolean
  onOpenPreset: () => void
  onClosePreset: () => void
  onPresetSaved: () => Promise<void>
}) {
  const isMapped = !!invoice.resolved_supplier_uid
  const accountMissing = isMapped && !invoice.resolved_account_uid

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>
          MYOB mapping ({invoice.myob_company_file})
        </div>
        {canEdit && !presetOpen && (
          <button onClick={onOpenPreset} style={btnSecondary()}>
            {isMapped ? 'Change…' : 'Set preset…'}
          </button>
        )}
        {canEdit && presetOpen && (
          <button onClick={onClosePreset} style={btnSecondary()}>Close</button>
        )}
      </div>

      {!presetOpen && isMapped && (
        <>
          <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
            <Field label="Supplier"        value={invoice.resolved_supplier_name}/>
            <Field label="Default account" value={invoice.resolved_account_code} mono/>
          </div>
          {accountMissing && (
            <div style={{marginTop:10, fontSize:11, color:T.amber}}>
              Supplier auto-matched but no default account on the MYOB supplier card.
              Click "Change…" to pick a default, or set per-line accounts in the line editor.
            </div>
          )}
        </>
      )}

      {!presetOpen && !isMapped && (
        <div style={{fontSize:12, color:T.amber}}>
          Supplier not mapped. {canEdit ? 'Click "Set preset…" to pick the MYOB supplier and account.' : 'Ask an admin to set the preset.'}
        </div>
      )}

      {presetOpen && (
        <SupplierPresetForm
          invoice={invoice}
          onSaved={onPresetSaved}
        />
      )}
    </div>
  )
}

function SupplierPresetForm({
  invoice, onSaved,
}: {
  invoice: InvoiceRow
  onSaved: () => Promise<void>
}) {
  const [pattern, setPattern] = useState<string>(
    (invoice.vendor_name_parsed || '').trim().toUpperCase().split(/[\s,]+/).slice(0, 2).join(' ') || ''
  )
  const [viaCapricorn, setViaCapricorn] = useState<boolean>(invoice.via_capricorn)
  const [supplier, setSupplier] = useState<MyobSupplier | null>(
    invoice.resolved_supplier_uid && invoice.resolved_supplier_name
      ? { uid: invoice.resolved_supplier_uid, displayId: null, name: invoice.resolved_supplier_name, abn: invoice.vendor_abn, isIndividual: false }
      : null
  )
  // Account starts with empty name when seeded from invoice.resolved_*
  // (the invoice row doesn't store the account name). AccountTypeahead's
  // displaySelected hydration will fetch and show the full name.
  const [account, setAccount] = useState<MyobAccount | null>(
    invoice.resolved_account_uid && invoice.resolved_account_code
      ? { uid: invoice.resolved_account_uid, displayId: invoice.resolved_account_code, name: '', type: 'Expense', parentName: null, isHeader: false }
      : null
  )
  const [saving, setSavingState] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (!pattern.trim()) { setError('Match pattern is required'); return }
    if (!supplier) { setError('Pick a MYOB supplier'); return }
    if (!account)  { setError('Pick a MYOB default account'); return }
    setError(null)
    setSavingState(true)
    try {
      const res = await fetch('/api/ap/supplier-presets', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: pattern.trim().toUpperCase(),
          matchAbn: invoice.vendor_abn || null,
          myobCompanyFile: invoice.myob_company_file,
          myobSupplierUid: supplier.uid,
          myobSupplierName: supplier.name,
          defaultAccountUid: account.uid,
          defaultAccountCode: account.displayId,
          defaultAccountName: account.name || null,
          viaCapricorn,
          applyToInvoiceId: invoice.id,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await onSaved()
    } catch (e: any) {
      setError(e?.message || String(e))
    } finally {
      setSavingState(false)
    }
  }

  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <FormRow label="Match pattern (case-insensitive substring of parsed vendor name)">
        <input
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          placeholder="e.g. REPCO"
          style={inputStyle()}
        />
      </FormRow>

      <div style={{fontSize:10, color:T.text3}}>
        Company file: <span style={{color:T.text2}}>{invoice.myob_company_file}</span>
      </div>

      <FormRow label="MYOB supplier">
        <SupplierTypeahead
          companyFile={invoice.myob_company_file}
          selected={supplier}
          onSelect={setSupplier}
          initialQuery={(invoice.vendor_name_parsed || '').trim()}
          createFrom={{
            vendorName: invoice.vendor_name_parsed,
            vendorAbn:  invoice.vendor_abn,
            email:      invoice.vendor_email,
            phone:      invoice.vendor_phone,
            website:    invoice.vendor_website,
            street:     invoice.vendor_street,
            city:       invoice.vendor_city,
            state:      invoice.vendor_state,
            postcode:   invoice.vendor_postcode,
            country:    invoice.vendor_country,
            ...deriveDefaultTaxCode(invoice),
          }}
        />
      </FormRow>

      <FormRow label="Default account (any account type)">
        <AccountTypeahead
          companyFile={invoice.myob_company_file}
          selected={account}
          onSelect={setAccount}
        />
      </FormRow>

      <div style={{display:'flex', alignItems:'center', gap:8}}>
        <input
          id="viaCapricorn"
          type="checkbox"
          checked={viaCapricorn}
          onChange={e => setViaCapricorn(e.target.checked)}
        />
        <label htmlFor="viaCapricorn" style={{fontSize:12, color:T.text2, cursor:'pointer'}}>
          This vendor is typically billed via Capricorn
        </label>
      </div>

      {error && (
        <div style={{fontSize:11, color:T.red, padding:'6px 10px', background:`${T.red}15`, border:`1px solid ${T.red}40`, borderRadius:5}}>
          {error}
        </div>
      )}

      <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
        <button
          onClick={save}
          disabled={saving || !supplier || !account || !pattern.trim()}
          style={{
            ...btnPrimary(),
            opacity: saving || !supplier || !account || !pattern.trim() ? 0.6 : 1,
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save preset & re-triage'}
        </button>
      </div>
      <div style={{fontSize:10, color:T.text3}}>
        Saving creates/updates a preset for the pattern. Future invoices whose parsed vendor name contains "{pattern.toUpperCase() || '…'}" will auto-resolve.
      </div>
    </div>
  )
}

// Pick a sensible default purchase tax code for a brand-new MYOB supplier
// card based on what the invoice itself shows. We don't want to assume
// every supplier is GST — banks, payroll, GST-exempt vendors etc. should
// default to FRE. The user can still flip the toggle in the create form.
//
// Signals (in priority order):
//   1. gst_amount > 0                   → GST
//   2. gst_amount === 0  AND total > 0  → FRE
//   3. subtotal_ex_gst ≈ total_inc_gst  → FRE  (no GST baked into the total)
//   4. fallback                         → GST
//
// Returns suggestedTaxCode + a one-line human-readable reason that
// renders under the toggle so the choice is auditable at create time.
function deriveDefaultTaxCode(inv: InvoiceRow): { suggestedTaxCode: 'GST' | 'FRE'; taxCodeReason: string } {
  const fmt = (n: number | null) => n == null ? '—' : `$${n.toFixed(2)}`
  const gst = inv.gst_amount  != null ? Number(inv.gst_amount)  : null
  const sub = inv.subtotal_ex_gst != null ? Number(inv.subtotal_ex_gst) : null
  const tot = inv.total_inc_gst   != null ? Number(inv.total_inc_gst)   : null

  if (gst != null && gst > 0.005) {
    return { suggestedTaxCode: 'GST', taxCodeReason: `invoice shows ${fmt(gst)} GST` }
  }
  if (gst != null && Math.abs(gst) < 0.005 && tot != null && tot > 0) {
    return { suggestedTaxCode: 'FRE', taxCodeReason: 'invoice shows $0 GST on a non-zero total' }
  }
  if (sub != null && tot != null && tot > 0 && Math.abs(sub - tot) < 0.05) {
    return { suggestedTaxCode: 'FRE', taxCodeReason: 'subtotal matches total — no GST baked in' }
  }
  return { suggestedTaxCode: 'GST', taxCodeReason: 'no clear GST/FRE signal — defaulting to GST' }
}

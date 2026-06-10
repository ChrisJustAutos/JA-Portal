// components/ap/HeaderEditForm.tsx
// Invoice-header edit form (extracted from pages/ap/[id].tsx).

import { T } from '../../lib/ui/theme'
import { HeaderEditable, inputStyle } from './shared'
import { FormRow } from './Primitives'

export function HeaderEditForm({
  value, onChange, disabled,
}: {
  value: HeaderEditable
  onChange: (patch: Partial<HeaderEditable>) => void
  disabled: boolean
}) {
  return (
    <div style={{display:'flex', flexDirection:'column', gap:12}}>
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:10}}>
        <FormRow label="Vendor">
          <input
            value={value.vendor_name_parsed}
            onChange={e => onChange({ vendor_name_parsed: e.target.value })}
            placeholder="e.g. TIME EXPRESS COURIER"
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
        <FormRow label="ABN">
          <input
            value={value.vendor_abn}
            onChange={e => onChange({ vendor_abn: e.target.value })}
            placeholder="11 digits"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Invoice #">
          <input
            value={value.invoice_number}
            onChange={e => onChange({ invoice_number: e.target.value })}
            placeholder="required to post"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Invoice date">
          <input
            type="date"
            value={value.invoice_date}
            onChange={e => onChange({ invoice_date: e.target.value })}
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
        <FormRow label="PO #">
          <input
            value={value.po_number}
            onChange={e => onChange({ po_number: e.target.value })}
            placeholder="(optional)"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace'}}
          />
        </FormRow>
        <FormRow label="Due date">
          <input
            type="date"
            value={value.due_date}
            onChange={e => onChange({ due_date: e.target.value })}
            disabled={disabled}
            style={inputStyle()}
          />
        </FormRow>
      </div>

      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(140px, 1fr))', gap:10}}>
        <FormRow label="Subtotal ex GST">
          <input
            value={value.subtotal_ex_gst}
            onChange={e => onChange({ subtotal_ex_gst: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right'}}
          />
        </FormRow>
        <FormRow label="GST">
          <input
            value={value.gst_amount}
            onChange={e => onChange({ gst_amount: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right'}}
          />
        </FormRow>
        <FormRow label="Total inc GST">
          <input
            value={value.total_inc_gst}
            onChange={e => onChange({ total_inc_gst: e.target.value })}
            placeholder="0.00"
            inputMode="decimal"
            disabled={disabled}
            style={{...inputStyle(), fontFamily:'monospace', textAlign:'right', fontWeight:600}}
          />
        </FormRow>
      </div>

      <FormRow label="Notes">
        <textarea
          value={value.notes}
          onChange={e => onChange({ notes: e.target.value })}
          placeholder="(optional)"
          disabled={disabled}
          rows={2}
          style={{
            ...inputStyle(),
            resize: 'vertical',
            minHeight: 50,
          }}
        />
      </FormRow>

      <div style={{fontSize:10, color:T.text3, lineHeight:1.5}}>
        Save runs triage again — fixing missing invoice # / total clears the matching RED reason. PO # changes also re-run the auto job-link.
      </div>
    </div>
  )
}

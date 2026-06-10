// components/ap/WorkshopJobSection.tsx
// Workshop Job (MD) link card with job-search picker
// (extracted from pages/ap/[id].tsx).

import { T } from '../../lib/ui/theme'
import { InvoiceRow, JobInfo, btnSecondary, fmtMoney } from './shared'
import { Field } from './Primitives'

export function WorkshopJobSection({
  invoice, linkedJob, canEdit,
  pickerOpen, pickerQuery, pickerResults, pickerLoading, linkBusy,
  onOpenPicker, onClosePicker, onPickerQueryChange, onPickJob, onUnlink,
}: {
  invoice: InvoiceRow
  linkedJob: JobInfo | null
  canEdit: boolean
  pickerOpen: boolean
  pickerQuery: string
  pickerResults: JobInfo[]
  pickerLoading: boolean
  linkBusy: boolean
  onOpenPicker: () => void
  onClosePicker: () => void
  onPickerQueryChange: (q: string) => void
  onPickJob: (jobNumber: string) => void
  onUnlink: () => void
}) {
  const poStatus = invoice.po_check_status
  const manual = invoice.linked_job_match_method === 'manual'

  let headline: { color: string; text: string }
  if (linkedJob) {
    if (manual) headline = { color: T.green, text: '✅ Linked (manual)' }
    else        headline = { color: T.green, text: '✅ Linked (auto by PO)' }
  } else if (poStatus === 'unmatched') {
    headline = { color: T.amber, text: `⚠️ PO ${invoice.po_number} doesn't match any open job` }
  } else if (poStatus === 'no-po-on-invoice' && invoice.via_capricorn) {
    headline = { color: T.text3, text: 'No PO on invoice (Capricorn-routed)' }
  } else if (poStatus === 'no-po-on-invoice') {
    headline = { color: T.text3, text: 'No PO on invoice' }
  } else {
    headline = { color: T.text3, text: 'PO check not run' }
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10, gap:8, flexWrap:'wrap'}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Workshop Job (MD)</div>
        {canEdit && !pickerOpen && (
          <div style={{display:'flex', gap:8}}>
            {linkedJob && (
              <button onClick={onUnlink} disabled={linkBusy} style={btnSecondary()}>
                {linkBusy ? 'Unlinking…' : 'Unlink'}
              </button>
            )}
            <button onClick={onOpenPicker} disabled={linkBusy} style={btnSecondary()}>
              {linkedJob ? 'Change…' : 'Find job…'}
            </button>
          </div>
        )}
        {canEdit && pickerOpen && (
          <button onClick={onClosePicker} style={btnSecondary()}>Close picker</button>
        )}
      </div>

      <div style={{fontSize:12, color: headline.color, marginBottom: linkedJob || pickerOpen ? 10 : 0}}>
        {headline.text}
      </div>

      {linkedJob && !pickerOpen && (
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px'}}>
          <Field label="Job #"        value={linkedJob.job_number} mono/>
          <Field label="Status"       value={linkedJob.status}/>
          <Field label="Customer"     value={linkedJob.customer_name}/>
          <Field label="Vehicle"      value={linkedJob.vehicle}/>
          <Field label="Job type"     value={linkedJob.job_type}/>
          <Field label="Platform"     value={linkedJob.vehicle_platform}/>
          <Field label="Opened"       value={linkedJob.opened_date}/>
          <Field label="Quoted total" value={fmtMoney(linkedJob.estimated_total)} mono align="right"/>
        </div>
      )}

      {pickerOpen && (
        <div style={{marginTop:8}}>
          <input
            autoFocus
            value={pickerQuery}
            onChange={e => onPickerQueryChange(e.target.value)}
            placeholder="Search by job # / customer / vehicle…"
            style={{
              width:'100%', boxSizing:'border-box',
              background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
              padding:'10px 12px', borderRadius:6,
              fontSize: 16, fontFamily:'inherit', outline:'none',
              marginBottom:10,
            }}
          />
          <div style={{
            border:`1px solid ${T.border}`, borderRadius:6, overflow:'hidden',
            maxHeight:300, overflowY:'auto', background: T.bg3,
          }}>
            {pickerLoading && (
              <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>Searching…</div>
            )}
            {!pickerLoading && pickerResults.length === 0 && (
              <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>
                {pickerQuery ? 'No matching jobs.' : 'Type to search…'}
              </div>
            )}
            {!pickerLoading && pickerResults.map((j, i) => (
              <div
                key={`${j.job_number}-${i}`}
                onClick={() => !linkBusy && onPickJob(j.job_number)}
                style={{
                  padding:'10px 12px',
                  borderTop: i > 0 ? `1px solid ${T.border}` : 'none',
                  cursor: linkBusy ? 'wait' : 'pointer',
                  fontSize: 12,
                  display:'grid', gridTemplateColumns:'80px 1fr 1fr 90px', gap:10, alignItems:'center',
                }}
              >
                <span style={{fontFamily:'monospace', color:T.text}}>{j.job_number}</span>
                <span style={{color:T.text2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.customer_name || '—'}</span>
                <span style={{color:T.text3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{j.vehicle || '—'}</span>
                <span style={{color:T.text3, fontSize:10, textTransform:'uppercase', letterSpacing:'0.05em'}}>{j.status || '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

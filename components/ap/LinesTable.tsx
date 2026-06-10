// components/ap/LinesTable.tsx
// AP invoice line-item table (read-only + edit mode) with per-line account
// cells, source badges and history suggestions
// (extracted from pages/ap/[id].tsx — Round 6 smart line→account pickup A+B).

import { T } from '../../lib/ui/theme'
import { LineRow, fmtMoney } from './shared'

export function LinesTable({
  lines, invoiceDefaultAccountCode, editable, selectedIds, onToggleSelect,
  onChange, onRemove, onPickAccount, onApplySuggestion,
}: {
  lines: LineRow[]
  invoiceDefaultAccountCode: string | null
  editable: boolean
  // Optional: present only in edit mode. When provided, renders a
  // checkbox column for partial-merge selection.
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
  onChange: (id: string, patch: Partial<LineRow>) => void
  onRemove: (id: string) => void
  onPickAccount: (lineId: string) => void
  onApplySuggestion: (l: LineRow) => void
}) {
  if (lines.length === 0) {
    return <div style={{padding:14, textAlign:'center', color:T.text3, fontSize:12}}>No line items.</div>
  }
  const showSelect = editable && !!onToggleSelect

  // Per-line GST: never charge GST on FRE lines (even if a stale
  // gst_amount lingers from extraction). Otherwise prefer the recorded
  // gst_amount so we display exactly what the supplier charged; only
  // fall back to a calculated 10% when gst_amount is missing.
  const perLineGst = (l: LineRow): number => {
    const tc = (l.tax_code || '').toUpperCase()
    if (tc === 'FRE') return 0
    const stored = l.gst_amount == null ? null : Number(l.gst_amount)
    if (stored !== null && Number.isFinite(stored)) return stored
    if (tc === 'GST') return Number(l.line_total_ex_gst || 0) * 0.10
    return 0
  }

  const totalEx       = lines.reduce((s, l) => s + Number(l.line_total_ex_gst || 0), 0)
  const totalGst      = lines.reduce((s, l) => s + perLineGst(l), 0)
  const taxableExSum  = lines.reduce((s, l) => s + ((l.tax_code || '').toUpperCase() === 'GST' ? Number(l.line_total_ex_gst || 0) : 0), 0)
  const freeExSum     = lines.reduce((s, l) => s + ((l.tax_code || '').toUpperCase() === 'FRE' ? Number(l.line_total_ex_gst || 0) : 0), 0)

  const preTotalExCols = showSelect ? 7 : 6
  const postGstCols    = editable ? 3 : 2

  return (
    <div style={{overflowX:'auto', WebkitOverflowScrolling:'touch'}}>
      <table style={{width:'100%', borderCollapse:'collapse', fontSize:12, minWidth: 720}}>
        <thead>
          <tr style={{borderBottom:`1px solid ${T.border}`}}>
            {showSelect && <th style={lh(28)} title="Tick to merge"/>}
            <th style={lh(36)}>#</th>
            <th style={lh(120)}>Part</th>
            <th style={lh()}>Description</th>
            <th style={{...lh(60), textAlign:'right'}}>Qty</th>
            <th style={lh(50)}>UoM</th>
            <th style={{...lh(80), textAlign:'right'}}>Unit ex</th>
            <th style={{...lh(80), textAlign:'right'}}>Total ex</th>
            <th style={{...lh(70), textAlign:'right'}}>GST $</th>
            <th style={lh(56)}>Tax</th>
            <th style={lh(220)}>Account</th>
            {editable && <th style={lh(40)}/>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id} style={{borderTop: i > 0 ? `1px solid ${T.border}` : 'none'}}>
              {showSelect && (
                <td style={{...ld(), textAlign:'center'}}>
                  <input
                    type="checkbox"
                    checked={!!selectedIds?.has(l.id)}
                    onChange={() => onToggleSelect!(l.id)}
                    style={{cursor:'pointer'}}
                    title="Include in merge"
                  />
                </td>
              )}
              <td style={ld()}>{l.line_no}</td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.part_number || ''} onChange={v => onChange(l.id, { part_number: v || null })}/>
                  : (l.part_number || <span style={{color:T.text3}}>—</span>)}
              </td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.description} onChange={v => onChange(l.id, { description: v })}/>
                  : l.description}
              </td>
              <td style={{...ld(), textAlign:'right'}}>
                {editable
                  ? <Inp value={l.qty?.toString() || ''} onChange={v => onChange(l.id, { qty: v === '' ? null : Number(v) || null })} alignRight/>
                  : (l.qty ?? '—')}
              </td>
              <td style={ld()}>
                {editable
                  ? <Inp value={l.uom || ''} onChange={v => onChange(l.id, { uom: v || null })}/>
                  : (l.uom || <span style={{color:T.text3}}>—</span>)}
              </td>
              <td style={{...ld(), textAlign:'right', fontFamily:'monospace'}}>
                {editable
                  ? <Inp value={l.unit_price_ex_gst?.toString() || ''} onChange={v => onChange(l.id, { unit_price_ex_gst: v === '' ? null : Number(v) || null })} alignRight/>
                  : fmtMoney(l.unit_price_ex_gst)}
              </td>
              <td style={{...ld(), textAlign:'right', fontFamily:'monospace'}}>
                {editable
                  ? <Inp value={l.line_total_ex_gst?.toString() || ''} onChange={v => onChange(l.id, { line_total_ex_gst: Number(v) || 0 })} alignRight/>
                  : fmtMoney(l.line_total_ex_gst)}
              </td>
              <td style={{
                ...ld(),
                textAlign:'right',
                fontFamily:'monospace',
                color: (l.tax_code || '').toUpperCase() === 'FRE' ? T.text3 : T.text,
              }}>
                {(l.tax_code || '').toUpperCase() === 'FRE'
                  ? <span title="GST-free line — no GST charged">—</span>
                  : fmtMoney(perLineGst(l))}
              </td>
              <td style={ld()}>
                {editable ? (
                  <select
                    value={l.tax_code}
                    onChange={e => onChange(l.id, { tax_code: e.target.value })}
                    style={{background:T.bg3, border:`1px solid ${T.border2}`, color:T.text, padding:'4px 6px', borderRadius:4, fontSize:12, fontFamily:'inherit'}}
                  >
                    {['GST','FRE','CAP','EXP','GNR','ITS','N-T'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <TaxCodePill code={l.tax_code}/>
                )}
              </td>
              <td style={ld()}>
                <AccountCell
                  line={l}
                  invoiceDefaultAccountCode={invoiceDefaultAccountCode}
                  editable={editable}
                  onPickAccount={onPickAccount}
                  onApplySuggestion={onApplySuggestion}
                />
              </td>
              {editable && (
                <td style={ld()}>
                  <button onClick={() => onRemove(l.id)} style={{background:'none', border:'none', color:T.red, cursor:'pointer', fontSize:18, padding:'4px 8px'}}>×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{borderTop:`2px solid ${T.border}`, background: T.bg3}}>
            <td colSpan={preTotalExCols} style={{padding:'8px 10px', fontSize:11, color:T.text3, fontWeight:500}}>
              {lines.length} line{lines.length === 1 ? '' : 's'}
            </td>
            <td style={{padding:'8px 10px', textAlign:'right', fontFamily:'monospace', fontSize:12, color:T.text, fontWeight:500}}>
              {fmtMoney(totalEx)}
            </td>
            <td style={{padding:'8px 10px', textAlign:'right', fontFamily:'monospace', fontSize:12, color:T.text, fontWeight:500}}>
              {fmtMoney(totalGst)}
            </td>
            <td colSpan={postGstCols} style={{padding:'8px 10px', fontSize:10, color:T.text3, lineHeight:1.5}}>
              <span title="Total ex-GST of lines with tax code GST">GST-taxable <span style={{fontFamily:'monospace', color:T.text}}>{fmtMoney(taxableExSum)}</span></span>
              <span style={{margin:'0 6px', color:T.border2}}>·</span>
              <span title="Total ex-GST of lines marked GST-free">GST-free <span style={{fontFamily:'monospace', color:T.text}}>{fmtMoney(freeExSum)}</span></span>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TaxCodePill({ code }: { code: string }) {
  const c = (code || '').toUpperCase()
  // GST = claimable (green), FRE = explicitly GST-free (amber). Anything
  // else (CAP, EXP, GNR, ITS, N-T) is rare on supplier bills, so render
  // as neutral so it doesn't accidentally look "approved".
  const color = c === 'GST' ? T.green
              : c === 'FRE' ? T.amber
              : T.text3
  return (
    <span style={{
      display:'inline-block',
      fontSize:10, fontWeight:600,
      color, background:`${color}15`, border:`1px solid ${color}40`,
      padding:'2px 7px', borderRadius:99,
      letterSpacing:'0.03em',
      fontFamily:'inherit',
    }}>
      {c || '—'}
    </span>
  )
}

function AccountCell({
  line, invoiceDefaultAccountCode, editable, onPickAccount, onApplySuggestion,
}: {
  line: LineRow
  invoiceDefaultAccountCode: string | null
  editable: boolean
  onPickAccount: (lineId: string) => void
  onApplySuggestion: (l: LineRow) => void
}) {
  const source = line.account_source || 'unset'
  const hasSuggestion = !line.account_uid && !!line.suggested_account_uid

  return (
    <div style={{display:'flex', flexDirection:'column', gap:4}}>
      {editable ? (
        <button
          onClick={() => onPickAccount(line.id)}
          title={line.account_name || (line.account_code ? '' : `Default: ${invoiceDefaultAccountCode || 'none'}`)}
          style={{
            background: T.bg3, border:`1px solid ${T.border2}`,
            color: line.account_code ? T.text : T.text3,
            padding:'5px 10px', borderRadius:4,
            fontSize:12, fontFamily:'inherit',
            cursor:'pointer', textAlign:'left',
            width:'100%', overflow:'hidden',
            minHeight: 32,
            display:'flex', flexDirection:'column', gap:1,
          }}
        >
          {line.account_code ? (
            <>
              <span style={{fontFamily:'monospace', color:T.text, lineHeight:1.2}}>{line.account_code}</span>
              {line.account_name && (
                <span style={{fontSize:10, color:T.text3, lineHeight:1.2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {line.account_name}
                </span>
              )}
            </>
          ) : (
            <span style={{color:T.text3}}>Default{invoiceDefaultAccountCode ? ` (${invoiceDefaultAccountCode})` : ''}</span>
          )}
        </button>
      ) : (
        line.account_code ? (
          <div style={{display:'flex', flexDirection:'column', gap:1}}>
            <span style={{fontSize:11, fontFamily:'monospace', color:T.text}}>{line.account_code}</span>
            {line.account_name && (
              <span style={{fontSize:10, color:T.text3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {line.account_name}
              </span>
            )}
          </div>
        ) : (
          <span style={{fontSize:11, color:T.text3}}>
            Default{invoiceDefaultAccountCode ? ` (${invoiceDefaultAccountCode})` : ''}
          </span>
        )
      )}

      {source === 'rule' && <span style={badgeStyle(T.teal)}>🔁 Rule</span>}
      {source === 'history-strong' && <span style={badgeStyle(T.teal)}>🔁 Auto</span>}
      {source === 'manual' && <span style={badgeStyle(T.text3)}>✋ Manual</span>}

      {hasSuggestion && (
        <div style={{
          display:'flex', alignItems:'center', gap:6,
          fontSize:10, color:T.amber,
          background:`${T.amber}10`, border:`1px solid ${T.amber}30`,
          padding:'3px 6px', borderRadius:3,
          width:'100%',
        }}>
          <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
            💡 <span style={{fontFamily:'monospace'}}>{line.suggested_account_code}</span>
            {line.suggested_account_name && <span style={{color:T.text3, marginLeft:4}}>{line.suggested_account_name}</span>}
          </span>
          {editable && (
            <button
              onClick={() => onApplySuggestion(line)}
              style={{
                background:'transparent', border:'none', color:T.amber,
                fontSize:10, cursor:'pointer', padding:'0 2px',
                fontFamily:'inherit', whiteSpace:'nowrap',
              }}
              title={line.suggested_account_name || ''}
            >
              Use →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize:9, color,
    background:`${color}15`, border:`1px solid ${color}40`,
    padding:'1px 5px', borderRadius:3,
    width:'fit-content',
    textTransform:'uppercase', letterSpacing:'0.04em', fontWeight:500,
  }
}

function Inp({ value, onChange, alignRight }: { value: string; onChange: (v: string) => void; alignRight?: boolean }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width:'100%', boxSizing:'border-box',
        background:T.bg3, border:`1px solid ${T.border2}`, color:T.text,
        padding:'5px 8px', borderRadius:4,
        fontSize:13, fontFamily:'inherit', outline:'none',
        textAlign: alignRight ? 'right' : 'left',
      }}
    />
  )
}

function lh(width?: number): React.CSSProperties {
  return { fontSize:10, color:T.text3, padding:'8px 10px', textAlign:'left', fontWeight:500, textTransform:'uppercase', letterSpacing:'0.05em', width }
}
function ld(): React.CSSProperties {
  return { padding:'8px 10px', verticalAlign:'top' }
}

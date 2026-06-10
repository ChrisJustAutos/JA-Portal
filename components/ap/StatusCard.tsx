// components/ap/StatusCard.tsx
// The triage/status header card on the AP detail page: pills, triage
// reasons, override notice, the desktop action row (clear error /
// override / reject / approve), posted/rejected banners and the action
// message (extracted from pages/ap/[id].tsx). All behaviour lives in the
// page — this renders state and calls back.

import { T, alpha } from '../../lib/ui/theme'
import { InvoiceRow } from './shared'
import { TriagePill, StatusPill } from './Primitives'

export function StatusCard({
  invoice, canEdit, isMobile, isTerminal, isPosted, isRejected,
  approving, rejecting, overriding, unposting, clearingError,
  canApprove, approveBlockedReason, willPostAsSpendMoney,
  actionMessage,
  onClearErrors, onClearTriageOverride, onSetTriageOverride,
  onReject, onApprove, onUnpost,
}: {
  invoice: InvoiceRow
  canEdit: boolean
  isMobile: boolean
  isTerminal: boolean
  isPosted: boolean
  isRejected: boolean
  approving: boolean
  rejecting: boolean
  overriding: boolean
  unposting: boolean
  clearingError: boolean
  canApprove: boolean
  approveBlockedReason: string
  willPostAsSpendMoney: boolean
  actionMessage: { kind: 'ok' | 'err'; text: string } | null
  onClearErrors: () => void
  onClearTriageOverride: () => void
  onSetTriageOverride: () => void
  onReject: () => void
  onApprove: () => void
  onUnpost: () => void
}) {
  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom: invoice.triage_reasons && invoice.triage_reasons.length > 0 ? 8 : 10, flexWrap:'wrap'}}>
        <TriagePill status={invoice.triage_status}/>
        <StatusPill status={invoice.status}/>
        {invoice.is_credit_note && (
          <span style={{
            fontSize:11, padding:'3px 10px', borderRadius:4,
            background:`${T.red}15`, color:T.red,
            border:`1px solid ${T.red}40`, fontWeight:600,
            letterSpacing:'0.04em',
          }}>
            CREDIT NOTE
          </span>
        )}
        <span style={{fontSize:11, color:T.text3}}>
          Parse: {invoice.parse_confidence || 'unknown'}
          {invoice.via_capricorn && (
            <> · <span style={{color:T.amber}}>via Capricorn{invoice.capricorn_reference ? ` ${invoice.capricorn_reference}` : ''}</span></>
          )}
        </span>
        <span style={{flex:1}}/>
        <span style={{fontSize:11, color:T.text3}}>{invoice.myob_company_file}</span>
      </div>
      {invoice.triage_reasons && invoice.triage_reasons.length > 0 && (
        <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:10}}>
          {invoice.triage_reasons.map((r, i) => {
            const isRed    = r.startsWith('RED:')
            const isYellow = r.startsWith('YELLOW:')
            const isInfo   = r.startsWith('INFO:')
            const c = isRed ? T.red : isYellow ? T.amber : isInfo ? T.teal : T.text3
            return (
              <span key={i} style={{
                fontSize:10, fontFamily:'monospace',
                padding:'2px 8px', borderRadius:3,
                background: `${c}15`,
                color: c,
                border: `1px solid ${c}40`,
              }}>{r}</span>
            )
          })}
        </div>
      )}

      {invoice.triage_override === 'green' && (
        <div style={{
          fontSize: 11, color: T.amber,
          background: `${T.amber}10`, border: `1px solid ${T.amber}40`,
          borderRadius: 6, padding: '6px 10px', marginBottom: 10,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span>🛈 Triage manually overridden → GREEN</span>
          {invoice.triage_override_reason && (
            <span style={{ color: T.text3 }}>· {invoice.triage_override_reason}</span>
          )}
          {invoice.triage_override_at && (
            <span style={{ color: T.text3, fontFamily: 'monospace', fontSize: 10 }}>
              · {new Date(invoice.triage_override_at).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {!isTerminal && canEdit && !isMobile && (
        <div style={{display:'flex', alignItems:'center', gap:8, paddingTop:10, borderTop:`1px solid ${T.border}`}}>
          {invoice.myob_post_error && (
            <>
              <span style={{fontSize:10, color:T.red, flex:1, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}
                title={invoice.myob_post_error}>
                Last error: {invoice.myob_post_error}
              </span>
              <button
                onClick={onClearErrors}
                disabled={clearingError}
                title="Dismiss this error message — only do this once you've confirmed the underlying issue is resolved"
                style={{
                  background:'transparent', border:'none', color:T.text3,
                  fontSize:11, cursor: clearingError ? 'wait' : 'pointer',
                  padding:'2px 6px', fontFamily:'inherit',
                  opacity: clearingError ? 0.5 : 1,
                }}>
                ✕ clear
              </button>
            </>
          )}
          {!invoice.myob_post_error && <span style={{flex:1}}/>}
          {invoice.triage_override === 'green' ? (
            <button
              onClick={onClearTriageOverride}
              disabled={overriding || approving || rejecting}
              title="Clear the triage override and recompute naturally"
              style={{
                background:'transparent', border:`1px solid ${T.amber}40`, color:T.amber,
                padding:'6px 14px', borderRadius:5, fontSize:11, fontFamily:'inherit',
                cursor: overriding ? 'wait' : 'pointer',
                opacity: overriding ? 0.6 : 1,
              }}>
              {overriding ? 'Working…' : 'Clear override'}
            </button>
          ) : invoice.triage_status !== 'red' && invoice.triage_status !== 'green' && (
            <button
              onClick={onSetTriageOverride}
              disabled={overriding || approving || rejecting}
              title="Force triage status to GREEN (e.g. for invoices with no PO that you've manually verified). Cannot bypass RED."
              style={{
                background:'transparent', border:`1px solid ${T.green}40`, color:T.green,
                padding:'6px 14px', borderRadius:5, fontSize:11, fontFamily:'inherit',
                cursor: overriding ? 'wait' : 'pointer',
                opacity: overriding ? 0.6 : 1,
              }}>
              {overriding ? 'Working…' : 'Override → Green'}
            </button>
          )}
          <button
            onClick={onReject}
            disabled={rejecting || approving || overriding}
            style={{
              background:'transparent', border:`1px solid ${T.red}40`, color:T.red,
              padding:'6px 14px', borderRadius:5, fontSize:11, fontFamily:'inherit',
              cursor: rejecting ? 'wait' : 'pointer',
              opacity: rejecting ? 0.6 : 1,
            }}>
            {rejecting ? 'Rejecting…' : 'Reject'}
          </button>
          <button
            onClick={onApprove}
            disabled={!canApprove || approving || rejecting}
            title={canApprove ? '' : `Cannot post: ${approveBlockedReason}`}
            style={{
              background: canApprove ? T.blue : T.bg4,
              color: canApprove ? '#fff' : T.text3,
              border:'none',
              padding:'6px 14px', borderRadius:5, fontSize:11, fontWeight:600, fontFamily:'inherit',
              cursor: !canApprove ? 'not-allowed' : approving ? 'wait' : 'pointer',
              opacity: approving ? 0.6 : 1,
            }}>
            {approving
              ? 'Posting…'
              : willPostAsSpendMoney
                ? 'Approve & Spend Money'
                : 'Approve & Post to MYOB'}
          </button>
        </div>
      )}
      {!isTerminal && canEdit && isMobile && invoice.myob_post_error && (
        <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`, fontSize:11, color:T.red, display:'flex', alignItems:'flex-start', gap:8}}>
          <span style={{flex:1, wordBreak:'break-word'}}>Last error: {invoice.myob_post_error}</span>
          <button
            onClick={onClearErrors}
            disabled={clearingError}
            style={{
              background:'transparent', border:`1px solid ${alpha(T.text3, '40')}`, color:T.text3,
              fontSize:11, cursor: clearingError ? 'wait' : 'pointer',
              padding:'4px 10px', borderRadius:4, fontFamily:'inherit',
              opacity: clearingError ? 0.5 : 1, flexShrink:0,
            }}>
            ✕ clear
          </button>
        </div>
      )}

      {isPosted && (
        <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`}}>
          <div style={{
            display:'flex', alignItems:'center', gap:10, flexWrap:'wrap',
            justifyContent:'space-between',
          }}>
            <div style={{fontSize:11, color:T.green, display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flex:1, minWidth:0}}>
              <span>✅ Posted to MYOB {invoice.myob_posted_at ? new Date(invoice.myob_posted_at).toLocaleString() : ''}</span>
              {invoice.myob_txn_type === 'spend_money' && (
                <span style={{fontSize:10, padding:'1px 6px', borderRadius:3, background:`${T.purple}20`, color:T.purple, border:`1px solid ${T.purple}40`}}>
                  SPEND MONEY
                </span>
              )}
              {invoice.myob_bill_uid && (
                <span style={{fontFamily:'monospace', color:T.text3}}>
                  · UID {invoice.myob_bill_uid.substring(0, 8)}…
                </span>
              )}
            </div>
            {canEdit && (
              <button
                onClick={onUnpost}
                disabled={unposting}
                title="Reset to pending_review (use if the bill was deleted in MYOB and you need to re-enter it)"
                style={{
                  background:'transparent',
                  border:`1px solid ${T.amber}50`,
                  color:T.amber,
                  padding:'5px 11px', borderRadius:5,
                  fontSize:11, fontFamily:'inherit',
                  cursor: unposting ? 'wait' : 'pointer',
                  opacity: unposting ? 0.6 : 1,
                  whiteSpace:'nowrap',
                }}
              >
                {unposting ? 'Un-posting…' : '↩ Un-post'}
              </button>
            )}
          </div>
          {invoice.myob_post_error && (
            <div style={{marginTop:6, fontSize:11, color:T.amber, display:'flex', alignItems:'flex-start', gap:8}}>
              <span style={{flex:1, wordBreak:'break-word'}}>⚠️ {invoice.myob_post_error}</span>
              {canEdit && (
                <button
                  onClick={onClearErrors}
                  disabled={clearingError}
                  title="Dismiss this note"
                  style={{
                    background:'transparent', border:'none', color:T.text3,
                    fontSize:11, cursor: clearingError ? 'wait' : 'pointer',
                    padding:'2px 6px', fontFamily:'inherit',
                    opacity: clearingError ? 0.5 : 1, flexShrink:0,
                  }}>
                  ✕ clear
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {isRejected && (
        <div style={{paddingTop:10, borderTop:`1px solid ${T.border}`, fontSize:11, color:T.text2}}>
          🚫 Rejected{invoice.rejection_reason ? ` — ${invoice.rejection_reason}` : ''}
        </div>
      )}

      {actionMessage && (
        <div style={{
          marginTop:10, padding:'8px 10px', borderRadius:5, fontSize:11,
          background: actionMessage.kind === 'ok' ? `${T.green}15` : `${T.red}15`,
          border: `1px solid ${actionMessage.kind === 'ok' ? T.green : T.red}40`,
          color: actionMessage.kind === 'ok' ? T.green : T.red,
        }}>
          {actionMessage.text}
        </div>
      )}
    </div>
  )
}

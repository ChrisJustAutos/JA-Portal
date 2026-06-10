// components/ap/PaymentSection.tsx
// Mark-as-paid card (extracted from pages/ap/[id].tsx). Tick the checkbox
// to apply a payment from a clearing account immediately after the bill
// posts to MYOB. Capricorn-routed invoices auto-tick the configured
// Capricorn default; user can still flip / change. Shown next to the
// workshop-job card.

import { T } from '../../lib/ui/theme'
import { InvoiceRow, PaymentAccount } from './shared'

export function PaymentSection({
  invoice, accounts, canEdit, canRetry, busy, retryBusy, onChange, onRetryPayment,
}: {
  invoice: InvoiceRow
  accounts: PaymentAccount[]
  canEdit: boolean
  canRetry: boolean
  busy: boolean
  retryBusy: boolean
  onChange: (acc: { uid: string; code: string; name: string } | null) => void
  onRetryPayment: () => void
}) {
  const isPosted     = invoice.status === 'posted'
  const isMarked     = !!invoice.payment_account_uid
  const cap          = accounts.find(a => a.is_default_for_capricorn)
  const empty        = accounts.length === 0
  const canShowRetry = canRetry
                    && !!invoice.myob_bill_uid
                    && !!invoice.payment_account_uid
                    && !invoice.myob_payment_uid
                    && !!invoice.myob_payment_error

  function toggleMarkAsPaid(on: boolean) {
    if (!on) { onChange(null); return }
    // Default selection: Capricorn default if invoice is via_capricorn,
    // otherwise the first active account.
    const pick = (invoice.via_capricorn && cap) ? cap : accounts[0]
    if (!pick) return
    onChange({ uid: pick.account_uid, code: pick.account_code, name: pick.account_name })
  }

  function pickAccount(uid: string) {
    const acc = accounts.find(a => a.account_uid === uid)
    if (!acc) return
    onChange({ uid: acc.account_uid, code: acc.account_code, name: acc.account_name })
  }

  return (
    <div style={{background:T.bg2, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px'}}>
      <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:10, flexWrap:'wrap'}}>
        <div style={{fontSize:11, color:T.text3, textTransform:'uppercase', letterSpacing:'0.05em'}}>Payment</div>
        {invoice.via_capricorn && (
          <span style={{fontSize:10, padding:'2px 8px', borderRadius:3, background:`${T.amber}20`, color:T.amber, border:`1px solid ${T.amber}40`}}>
            via Capricorn
          </span>
        )}
        <div style={{flex:1}}/>
        {invoice.myob_payment_uid && (
          <span style={{fontSize:11, color:T.green}}>
            ✅ Payment applied
            <span style={{fontFamily:'monospace', color:T.text3, marginLeft:6}}>UID {invoice.myob_payment_uid.substring(0, 8)}…</span>
          </span>
        )}
        {invoice.myob_payment_error && !invoice.myob_payment_uid && (
          <span title={invoice.myob_payment_error} style={{fontSize:11, color:T.red, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:300}}>
            ⚠️ Payment failed: {invoice.myob_payment_error}
          </span>
        )}
        {canShowRetry && (
          <button
            onClick={onRetryPayment}
            disabled={retryBusy}
            style={{
              padding:'5px 12px', borderRadius:5,
              border:`1px solid ${T.amber}40`,
              background:'transparent', color: T.amber,
              fontSize:11, fontFamily:'inherit',
              cursor: retryBusy ? 'wait' : 'pointer',
              opacity: retryBusy ? 0.6 : 1,
            }}>
            {retryBusy ? 'Retrying…' : 'Retry payment'}
          </button>
        )}
      </div>

      {empty && canEdit && !isPosted && (
        <div style={{fontSize:11, color:T.text3, lineHeight:1.5}}>
          No payment clearing accounts configured. Add one in Settings → MYOB Connection → Payment clearing accounts.
        </div>
      )}

      {!empty && (
        <>
          <label style={{
            display:'flex', alignItems:'center', gap:8, cursor: canEdit && !isPosted ? 'pointer' : 'not-allowed',
            opacity: canEdit && !isPosted ? 1 : 0.6,
          }}>
            <input
              type="checkbox"
              checked={isMarked}
              disabled={!canEdit || isPosted || busy}
              onChange={e => toggleMarkAsPaid(e.target.checked)}
              style={{margin:0}}
            />
            <span style={{fontSize:12, color:T.text}}>
              {invoice.is_credit_note
                ? 'Mark as refunded — apply refund to a clearing account'
                : 'Mark as paid — apply payment to a clearing account'}
            </span>
          </label>

          {isMarked && (
            <div style={{marginTop:10, paddingLeft:24}}>
              <div style={{fontSize:10, color:T.text3, marginBottom:4, textTransform:'uppercase', letterSpacing:'0.05em'}}>
                {invoice.is_credit_note ? 'Refund to' : 'Pay from'}
              </div>
              <select
                value={invoice.payment_account_uid || ''}
                disabled={!canEdit || isPosted || busy}
                onChange={e => pickAccount(e.target.value)}
                style={{
                  width:'100%', maxWidth:420,
                  background: T.bg3, border:`1px solid ${T.border2}`, color: T.text,
                  borderRadius:6, padding:'7px 10px', fontSize:12, outline:'none',
                  fontFamily:'inherit',
                }}>
                {accounts.map(a => (
                  <option key={a.id} value={a.account_uid}>
                    {a.label} — {a.account_code} {a.account_name}{a.is_default_for_capricorn ? ' (Cap default)' : ''}
                  </option>
                ))}
              </select>
              <div style={{fontSize:10, color:T.text3, marginTop:6, lineHeight:1.5}}>
                {invoice.is_credit_note
                  ? 'When this credit note is posted, a Pay Refund will immediately credit this account by the full amount, settling the supplier credit.'
                  : 'When this invoice is posted, a Purchase Payment will immediately apply the full amount from this account, settling the bill.'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// lib/ap-auto-entry-slack.ts
// Slack Block Kit builder for the VPS automated-invoice-entry notifications.
// Two shapes: a "posted to MYOB" success card and a "couldn't auto-post" flag
// card. Both carry the invoice breakdown + a "View invoice" button (signed URL).

import type { SlackBlock } from './slack'

export type BankCheck = 'match' | 'mismatch' | 'unverified' | 'no-invoice-bank' | 'skipped'

export interface AutoEntrySlackInput {
  outcome: 'posted' | 'flagged'
  supplierName: string | null
  companyFile: string
  invoiceNumber: string | null
  invoiceDate: string | null
  totalIncGst: number | null
  gstAmount: number | null
  codingSummary: string | null   // "Cost of Goods - Parts" or "4 lines coded"
  bankCheck: BankCheck
  invoiceBank?: { bsb: string | null; accountNumber: string | null; accountName: string | null } | null
  failReasons?: string[]
  adopted?: boolean
  pdfUrl?: string | null
}

const money = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const BANK_BADGE: Record<BankCheck, string> = {
  match:            '✅ bank matches MYOB card',
  mismatch:         '🚨 bank details DIFFER from MYOB card',
  unverified:       '⚠️ no bank details on MYOB card — unverified',
  'no-invoice-bank':'— no bank details on invoice',
  skipped:          '',
}

// Human-readable fact-check reasons from the triage codes (RED:/YELLOW:).
function prettyReason(code: string): string {
  const map: Record<string, string> = {
    'missing-invoice-number': 'no invoice number',
    'missing-total': 'no total',
    'low-parse-confidence': 'low parse confidence',
    'no-line-items': 'no line items',
    'supplier-not-mapped': 'supplier not matched to a MYOB card',
    'account-not-mapped': "couldn't auto-code the account",
    'medium-parse-confidence': 'medium parse confidence',
    'missing-invoice-date': 'no invoice date',
    'totals-mismatch': 'subtotal + GST ≠ total',
    'line-sum-mismatch': "lines don't sum to subtotal",
    'bank-mismatch': 'bank details differ from the MYOB card',
  }
  const bare = code.replace(/^(RED|YELLOW|INFO):/, '').split(':')[0]
  return map[bare] || bare
}

export function buildAutoEntryBlocks(i: AutoEntrySlackInput): { text: string; blocks: SlackBlock[] } {
  const supplier = i.supplierName || 'Unknown supplier'
  const headline = i.outcome === 'posted'
    ? `✅ Posted to MYOB — ${supplier}${i.adopted ? ' (already in MYOB, linked)' : ''}`
    : `🟠 Not auto-posted — ${supplier}`
  const text = `${headline} · ${i.invoiceNumber || 'no #'} · ${money(i.totalIncGst)}`

  const fields = [
    `*Supplier:*\n${supplier}`,
    `*Company file:*\n${i.companyFile}`,
    `*Invoice #:*\n${i.invoiceNumber || '—'}`,
    `*Date:*\n${i.invoiceDate || '—'}`,
    `*Total (inc GST):*\n${money(i.totalIncGst)}`,
    `*GST:*\n${money(i.gstAmount)}`,
  ]
  if (i.codingSummary) fields.push(`*Coded to:*\n${i.codingSummary}`)
  const bankBadge = BANK_BADGE[i.bankCheck]
  if (bankBadge) fields.push(`*Payment details:*\n${bankBadge}`)

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headline.slice(0, 150), emoji: true } },
    { type: 'section', fields: fields.map(t => ({ type: 'mrkdwn', text: t.slice(0, 2000) })) },
  ]

  // Show the invoice's bank details when they matter (mismatch / unverified).
  if ((i.bankCheck === 'mismatch' || i.bankCheck === 'unverified') && i.invoiceBank && (i.invoiceBank.bsb || i.invoiceBank.accountNumber)) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Bank details on invoice:* BSB ${i.invoiceBank.bsb || '—'} · Acct ${i.invoiceBank.accountNumber || '—'}${i.invoiceBank.accountName ? ` · ${i.invoiceBank.accountName}` : ''}` },
    })
  }

  if (i.outcome === 'flagged' && i.failReasons && i.failReasons.length) {
    const reasons = Array.from(new Set(i.failReasons.map(prettyReason))).slice(0, 8)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Why it wasn't auto-posted:*\n• ${reasons.join('\n• ')}\n_Left in the inbox for manual entry._` },
    })
  }

  if (i.pdfUrl) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View invoice', emoji: true }, url: i.pdfUrl }],
    })
  }

  return { text: text.slice(0, 300), blocks }
}

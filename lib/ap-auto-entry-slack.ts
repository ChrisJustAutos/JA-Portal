// lib/ap-auto-entry-slack.ts
// Slack Block Kit builder for the VPS automated-invoice-entry notifications.
// Two shapes: a "posted to MYOB" success card and a "couldn't auto-post" flag
// card. Both carry the invoice breakdown + a "View invoice" button (signed URL).

import type { SlackBlock } from './slack'

export type BankCheck = 'match' | 'mismatch' | 'mismatch-exempt' | 'capricorn' | 'unverified' | 'no-invoice-bank' | 'skipped'

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
  cardBank?: { bsb: string | null; accountNumber: string | null; accountName: string | null } | null
  sourceMailbox?: string | null
  supplierTrust?: string | null   // e.g. "✓ Verified — 14 posted · ABN match · known sender"
  paidOnInvoice?: string | null   // payment method when the invoice is already settled ('card', 'EFT'…)
  // ap_auto_entry_log row id — renders an "Approve & post to MYOB" button on
  // flag cards (handled by /api/slack/ask → approveAndPost).
  approveValue?: string | null
  // Same row id — renders a "➕ Create supplier" button on supplier-not-mapped
  // flag cards. Click extracts the vendor's details off the invoice and
  // threads them for review (handled by /api/slack/ask → proposeSupplier).
  createSupplierValue?: string | null
  // JAWS account-choice buttons: post the flagged invoice coded to a chosen
  // account. First option is the system's best guess (shown "suggested").
  // Each → action_id ap_post_account, value {r:rowId,a:uid,n:name}.
  accountOptions?: { uid: string; displayId: string; name: string; suggested?: boolean }[] | null
  // Credit note — amounts arrive already NEGATIVE; the card labels it.
  isCreditNote?: boolean
  failReasons?: string[]
  adopted?: boolean
  pdfUrl?: string | null
}

const money = (n: number | null | undefined) =>
  n == null || !isFinite(n) ? '—' : `${Number(n) < 0 ? '-' : ''}$${Math.abs(Number(n)).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const BANK_BADGE: Record<BankCheck, string> = {
  match:            '✅ bank matches MYOB card',
  mismatch:         '🚨 bank details DIFFER from MYOB card',
  'mismatch-exempt':'⚠️ bank differs — statement account, reconciled at EOM',
  capricorn:        '— paid via Capricorn (invoice bank details n/a)',
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
    'foreign-currency': 'foreign currency — enter manually at the converted AUD rate',
    'possible-duplicate-of': 'possible duplicate — same supplier + amount recently posted under a different invoice number',
  }
  const bare = code.replace(/^(RED|YELLOW|INFO):/, '').split(':')[0]
  return map[bare] || bare
}

export function buildAutoEntryBlocks(i: AutoEntrySlackInput): { text: string; blocks: SlackBlock[] } {
  const supplier = i.supplierName || 'Unknown supplier'
  const creditTag = i.isCreditNote ? ' (credit note)' : ''
  const headline = i.outcome === 'posted'
    ? `✅ Posted to MYOB${creditTag} — ${supplier}${i.adopted ? ' (already in MYOB, linked)' : ''}`
    : `🟠 Not auto-posted${creditTag} — ${supplier}`
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
  if (i.sourceMailbox) fields.push(`*Source:*\n${i.sourceMailbox.split('@')[0]}@`)
  if (i.supplierTrust) fields.push(`*Supplier trust:*\n${i.supplierTrust}`)
  if (i.paidOnInvoice) fields.push(`*Already paid:*\n💳 ${i.paidOnInvoice} — don't pay again`)

  // Slack caps a section at 10 fields — the card grew past that (trust +
  // already-paid badges made 11 and Slack silently rejected the whole message,
  // PSR150252) — so chunk into sections of 8.
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: headline.slice(0, 150), emoji: true } },
  ]
  for (let i = 0; i < fields.length; i += 8) {
    blocks.push({ type: 'section', fields: fields.slice(i, i + 8).map(t => ({ type: 'mrkdwn', text: t.slice(0, 2000) })) })
  }

  // Show BOTH sides of the bank comparison when it matters (mismatch /
  // unverified) so the reader can spot the differing digit — or a misread on
  // a poor scan — without opening MYOB.
  if ((i.bankCheck === 'mismatch' || i.bankCheck === 'mismatch-exempt' || i.bankCheck === 'unverified') && i.invoiceBank && (i.invoiceBank.bsb || i.invoiceBank.accountNumber)) {
    const fmt = (b: { bsb: string | null; accountNumber: string | null; accountName: string | null }) =>
      `BSB ${b.bsb || '—'} · Acct ${b.accountNumber || '—'}${b.accountName ? ` · ${b.accountName}` : ''}`
    const lines = [`*Bank details on invoice:* ${fmt(i.invoiceBank)}`]
    if (i.cardBank && (i.cardBank.bsb || i.cardBank.accountNumber)) lines.push(`*Bank details on MYOB card:* ${fmt(i.cardBank)}`)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } })
  }

  if (i.outcome === 'flagged' && i.failReasons && i.failReasons.length) {
    const reasons = Array.from(new Set(i.failReasons.map(prettyReason))).slice(0, 8)
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Why it wasn't auto-posted:*\n• ${reasons.join('\n• ')}\n_Left in the inbox for manual entry._` },
    })
  }

  const actions: any[] = []
  if (i.pdfUrl) {
    actions.push({ type: 'button', text: { type: 'plain_text', text: 'View invoice', emoji: true }, url: i.pdfUrl })
  }
  if (i.outcome === 'flagged' && i.approveValue) {
    actions.push({
      type: 'button', style: 'primary', action_id: 'ap_approve_post', value: i.approveValue,
      text: { type: 'plain_text', text: '✅ Approve & post to MYOB', emoji: true },
      confirm: {
        title: { type: 'plain_text', text: 'Post to MYOB?' },
        text: { type: 'mrkdwn', text: `Post *${i.supplierName || 'this invoice'}* ${i.invoiceNumber || ''} for *${money(i.totalIncGst) === '—' ? '?' : money(i.totalIncGst)}*${i.isCreditNote ? ' (credit note — posts negative)' : ''} — you're vouching for the flagged checks.` },
        confirm: { type: 'plain_text', text: 'Post it' },
        deny: { type: 'plain_text', text: 'Cancel' },
      },
    })
  }
  if (i.outcome === 'flagged' && i.createSupplierValue) {
    actions.push({
      type: 'button', action_id: 'ap_create_supplier', value: i.createSupplierValue,
      text: { type: 'plain_text', text: '➕ Create supplier', emoji: true },
    })
  }
  if (actions.length) blocks.push({ type: 'actions', elements: actions })

  // JAWS account-choice row: one button per candidate expense account. The
  // suggested account is styled primary and labelled; picking any posts the
  // invoice coded to that account (handled by /api/slack/ask → postWithAccount).
  if (i.outcome === 'flagged' && i.approveValue && i.accountOptions?.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '*Post coded to which account?*' }] })
    const acctButtons = i.accountOptions.slice(0, 5).map(opt => ({
      type: 'button',
      ...(opt.suggested ? { style: 'primary' as const } : {}),
      action_id: `ap_post_account_${opt.uid}`,
      value: JSON.stringify({ r: i.approveValue, a: opt.uid, n: `${opt.displayId} ${opt.name}`.trim() }),
      text: { type: 'plain_text', text: `${opt.suggested ? '⭐ ' : ''}${opt.displayId} ${opt.name}`.slice(0, 75), emoji: true },
    }))
    blocks.push({ type: 'actions', elements: acctButtons })
  }

  return { text: text.slice(0, 300), blocks }
}

// Transform an EXISTING flag card (its posted Slack blocks) into the
// "approved & posted" state, for chat.update after the Approve button posts:
//   • header 🟠 → ✅ "Approved & posted to MYOB"
//   • drop the Approve button (keep View invoice); remove an emptied actions row
//   • drop the "Why it wasn't auto-posted" section, add an approver context line
// Returns new blocks + fallback text. Pure — safe to call on the raw payload
// message blocks.
export function markApprovedBlocks(
  original: SlackBlock[],
  opts: { approver: string; resultText: string },
): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = []
  for (const b of Array.isArray(original) ? original : []) {
    if (b?.type === 'header') {
      const t = String(b.text?.text || '')
      const flipped = t.replace(/^🟠\s*Not auto-posted/i, '✅ Approved & posted to MYOB')
      blocks.push({ ...b, text: { ...b.text, text: (flipped === t ? `✅ ${t}` : flipped).slice(0, 150) } })
      continue
    }
    // Drop the "why it wasn't auto-posted" explanation — no longer true.
    if (b?.type === 'section' && /why it wasn't auto-posted/i.test(String(b.text?.text || ''))) continue
    // Rebuild the actions row without the approve button.
    if (b?.type === 'actions') {
      const kept = (b.elements || []).filter((e: any) => e?.action_id !== 'ap_approve_post' && e?.action_id !== 'ap_create_supplier')
      if (kept.length) blocks.push({ ...b, elements: kept })
      continue
    }
    blocks.push(b)
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `✅ ${escOr(opts.resultText, `Approved by ${opts.approver}`)}`.slice(0, 2900) }] })
  return { text: `✅ Approved & posted to MYOB — approved by ${opts.approver}`.slice(0, 300), blocks }
}

function escOr(s: string | null | undefined, fallback: string): string {
  const t = String(s || '').trim()
  return t || fallback
}

// ── "Create supplier" proposal (threaded under the flag card) ─────────────
// Shows every detail lifted off the invoice so a human can eyeball it before
// the card is created in MYOB. The approve button carries just the row id —
// the reviewed details are persisted on the log row (proposed_supplier), so
// what was approved is exactly what gets created.
export interface SupplierProposal {
  name: string
  abn: string | null
  email: string | null
  phone: string | null
  website: string | null
  street: string | null
  city: string | null
  state: string | null
  postcode: string | null
  country: string | null
  taxCode: 'GST' | 'FRE'
}

export function buildSupplierProposalBlocks(i: {
  proposal: SupplierProposal
  companyFile: string
  rowId: string
  invoiceNumber: string | null
  totalIncGst: number | null
  // Existing MYOB cards with similar names — shown so the reviewer can spot
  // "this already exists under a slightly different name" before creating.
  nearMatches?: { name: string; displayId?: string | null }[] | null
}): { text: string; blocks: SlackBlock[] } {
  const p = i.proposal
  const text = `➕ New ${i.companyFile} supplier proposed: ${p.name}`
  const dash = (v: string | null | undefined) => (v && v.trim()) || '—'
  const address = [p.street, [p.city, p.state, p.postcode].filter(Boolean).join(' '), p.country]
    .map(s => (s || '').trim()).filter(Boolean).join(', ')
  const fields = [
    `*Company name:*\n${dash(p.name)}`,
    `*ABN:*\n${dash(p.abn)}`,
    `*Email:*\n${dash(p.email)}`,
    `*Phone:*\n${dash(p.phone)}`,
    `*Website:*\n${dash(p.website)}`,
    `*Address:*\n${dash(address)}`,
    `*Tax code (buying):*\n${p.taxCode}`,
    `*Company file:*\n${i.companyFile}`,
  ]
  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*➕ Create this ${i.companyFile} supplier card?* Details read off the invoice — check them before approving.` } },
    { type: 'section', fields: fields.map(t => ({ type: 'mrkdwn', text: t.slice(0, 2000) })) },
  ]
  if (i.nearMatches?.length) {
    const lines = i.nearMatches.slice(0, 5).map(m => `• ${m.name}${m.displayId ? ` (${m.displayId})` : ''}`)
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*⚠️ Similar existing cards — make sure none of these is the same supplier:*\n${lines.join('\n')}` } })
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Bank/payment details are never auto-written — add them in MYOB manually if needed.' }] })
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button', style: 'primary', action_id: 'ap_create_supplier_go', value: i.rowId,
      text: { type: 'plain_text', text: '✅ Create supplier & post bill', emoji: true },
      confirm: {
        title: { type: 'plain_text', text: 'Create supplier + post?' },
        text: { type: 'mrkdwn', text: `Create *${p.name}* in MYOB ${i.companyFile} and post invoice ${i.invoiceNumber || ''} for *${money(i.totalIncGst)}*.` },
        confirm: { type: 'plain_text', text: 'Create & post' },
        deny: { type: 'plain_text', text: 'Cancel' },
      },
    }],
  })
  return { text: text.slice(0, 300), blocks }
}

// Flip a proposal message to its done state after the approve click — strip
// the button (prevents double-creates) and append the outcome line.
export function markProposalDoneBlocks(
  original: SlackBlock[],
  resultText: string,
): { text: string; blocks: SlackBlock[] } {
  const blocks = (Array.isArray(original) ? original : []).filter(b => b?.type !== 'actions')
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: resultText.slice(0, 2900) }] })
  return { text: resultText.slice(0, 300), blocks }
}

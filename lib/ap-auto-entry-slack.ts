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
  // Same row id — renders a "🔍 Entered manually?" button on flag cards.
  // Click searches MYOB for a bill someone keyed in by hand; a hit marks the
  // flag POSTED MANUALLY and files the email away (→ checkEnteredManually).
  checkManualValue?: string | null
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
      text: { type: 'mrkdwn', text: `*Why it wasn't auto-posted:*\n• ${reasons.join('\n• ')}\n`
        // A missing button with no explanation reads as a broken card, so say
        // that its absence is deliberate and why.
        + (i.outcome === 'flagged' && !i.approveValue
          ? '*There is no approve button on this one.* A double-up across the two company files could not be ruled out, and approving is how something gets paid twice. Check both files, then enter it by hand.'
          : '_Left in the inbox for manual entry._') },
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
  if (i.outcome === 'flagged' && i.checkManualValue) {
    actions.push({
      type: 'button', action_id: 'ap_check_manual', value: i.checkManualValue,
      text: { type: 'plain_text', text: '🔍 Entered manually?', emoji: true },
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
  return markResolvedBlocks(original, {
    headline: '✅ Approved & posted to MYOB',
    contextText: `✅ ${escOr(opts.resultText, `Approved by ${opts.approver}`)}`,
    fallbackText: `✅ Approved & posted to MYOB — approved by ${opts.approver}`,
  })
}

// Same transformation for the "🔍 Entered manually?" check finding the bill
// already in MYOB: the invoice IS entered, just not by the automation.
export function markPostedManuallyBlocks(
  original: SlackBlock[],
  opts: { checkedBy: string; resultText: string },
): { text: string; blocks: SlackBlock[] } {
  return markResolvedBlocks(original, {
    headline: '✅ Posted manually',
    contextText: `✅ ${escOr(opts.resultText, `Found in MYOB by ${opts.checkedBy}`)}`,
    fallbackText: `✅ Posted manually — found in MYOB by ${opts.checkedBy}`,
  })
}

// Shared card-flip: swap the 🟠 header for a resolved one, drop the
// "why it wasn't auto-posted" section and every action button that would now
// double-post, and append the outcome as a context line. Pure.
const RESOLVED_STRIP_ACTIONS = ['ap_approve_post', 'ap_create_supplier', 'ap_check_manual']

// An OPEN flag card's header, as Slack hands it back to us.
//
// Slack stores the emoji we posted as its SHORTCODE, so a card read back
// through conversations.replies (or off a button's interaction payload) has
// the header ":large_orange_circle: Not auto-posted — Supplier", NOT the
// "🟠 …" we sent. Matching only the literal emoji silently matched nothing —
// it made the 2026-08-25 button backfill skip every card it was pointed at.
// Both forms are accepted here, and the "Not auto-posted" text is the real
// anchor: a card that has been flipped no longer contains it.
const OPEN_FLAG_HEADER = /^\s*(?::large_orange_circle:|🟠)?\s*Not auto-posted/i

function markResolvedBlocks(
  original: SlackBlock[],
  opts: { headline: string; contextText: string; fallbackText: string },
): { text: string; blocks: SlackBlock[] } {
  const blocks: SlackBlock[] = []
  for (const b of Array.isArray(original) ? original : []) {
    if (b?.type === 'header') {
      const t = String(b.text?.text || '')
      const flipped = t.replace(OPEN_FLAG_HEADER, opts.headline)
      blocks.push({ ...b, text: { ...b.text, text: (flipped === t ? `✅ ${t}` : flipped).slice(0, 150) } })
      continue
    }
    // Drop the "why it wasn't auto-posted" explanation — no longer true.
    if (b?.type === 'section' && /why it wasn't auto-posted/i.test(String(b.text?.text || ''))) continue
    // Drop the account-choice prompt + its buttons (they'd post a second bill).
    if (b?.type === 'context' && /post coded to which account/i.test(String(b.elements?.[0]?.text || ''))) continue
    // Rebuild the actions row without anything that would post again.
    if (b?.type === 'actions') {
      const kept = (b.elements || []).filter((e: any) =>
        !RESOLVED_STRIP_ACTIONS.includes(String(e?.action_id || '')) &&
        !String(e?.action_id || '').startsWith('ap_post_account_'))
      if (kept.length) blocks.push({ ...b, elements: kept })
      continue
    }
    blocks.push(b)
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.contextText.slice(0, 2900) }] })
  return { text: opts.fallbackText.slice(0, 300), blocks }
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

// ── Retro-fit the "🔍 Entered manually?" button onto a posted card ──
// Cards posted before the button existed still need it, and re-posting them
// would lose the thread. Pure: takes the live message blocks, returns new
// blocks, or null when the card must not be touched — already carries the
// button, or is no longer an open flag (header already flipped green).
export type AddButtonResult = { blocks: SlackBlock[]; skip?: undefined } | { blocks?: undefined; skip: string }

export function addCheckManualButton(original: SlackBlock[], rowId: string): AddButtonResult {
  const blocks = Array.isArray(original) ? original : []
  if (!blocks.length) return { skip: 'card has no blocks' }
  if (!rowId) return { skip: 'no log row id' }

  // Only OPEN flag cards — a card that has been approved, posted manually or
  // otherwise resolved no longer says "Not auto-posted" in its header.
  const header = blocks.find(b => b?.type === 'header')
  const headerText = String(header?.text?.text || '').trim()
  if (!OPEN_FLAG_HEADER.test(headerText)) {
    return { skip: `not an open flag card (header: "${headerText.slice(0, 60) || 'none'}")` }
  }

  const elementsOf = (b: any) => (Array.isArray(b?.elements) ? b.elements : [])
  const already = blocks.some(b => b?.type === 'actions' && elementsOf(b).some((e: any) => e?.action_id === 'ap_check_manual'))
  if (already) return { skip: 'already has the button' }

  const button = {
    type: 'button', action_id: 'ap_check_manual', value: rowId,
    text: { type: 'plain_text', text: '🔍 Entered manually?', emoji: true },
  }

  // Prefer the card's main action row — the one holding Approve / View
  // invoice. NOT the JAWS account-choice row (ap_post_account_*), where the
  // button would read as another "post it" option.
  const mainIdx = blocks.findIndex(b => b?.type === 'actions' &&
    elementsOf(b).some((e: any) => !String(e?.action_id || '').startsWith('ap_post_account_')))
  if (mainIdx >= 0) {
    const out = blocks.slice()
    out[mainIdx] = { ...blocks[mainIdx], elements: [...elementsOf(blocks[mainIdx]), button] }
    return { blocks: out }
  }

  // No action row at all (a card whose PDF staging failed): add one, above the
  // account-choice prompt if there is one, so it stays with the card body.
  const promptIdx = blocks.findIndex(b => b?.type === 'context' &&
    /post coded to which account/i.test(String(b?.elements?.[0]?.text || '')))
  const row: SlackBlock = { type: 'actions', elements: [button] }
  const at = promptIdx >= 0 ? promptIdx : blocks.length
  return { blocks: [...blocks.slice(0, at), row, ...blocks.slice(at)] }
}

// ── "🔍 Entered manually?" near-misses (threaded under the flag card) ──
// The exact search found nothing, but MYOB holds bills for the same supplier
// at the same amount under a different number — typical of a hand entry that
// keyed the invoice number differently. Shown for a human to confirm; the
// button links the chosen bill and marks the flag posted manually.
export function buildManualCandidateBlocks(i: {
  rowId: string
  companyFile: string
  checkedBy: string
  supplierName: string | null
  invoiceNumber: string | null
  amount: number | null
  candidates: { uid: string; number: string | null; date: string | null; totalAmount: number | null; supplierInvoiceNumber: string | null }[]
}): { text: string; blocks: SlackBlock[] } {
  const text = `🔎 No exact match for ${i.invoiceNumber || 'this invoice'} — but ${i.candidates.length} same-amount bill(s) exist in MYOB ${i.companyFile}`
  const lines = i.candidates.map(b => {
    const bits = [
      `#${b.number || '?'}`,
      b.date ? String(b.date).slice(0, 10) : null,
      b.totalAmount != null ? money(Math.abs(Number(b.totalAmount))) : null,
      b.supplierInvoiceNumber ? `their ref ${b.supplierInvoiceNumber}` : 'no supplier invoice number',
    ].filter(Boolean)
    return `• ${bits.join(' · ')}`
  })
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔎 Not found under ${i.invoiceNumber || 'that number'}* — but MYOB ${i.companyFile} has ${i.candidates.length === 1 ? 'a bill' : `${i.candidates.length} bills`} for *${i.supplierName || 'this supplier'}* at the same amount${i.amount != null ? ` (${money(i.amount)})` : ''}:\n${lines.join('\n')}\n\nIf one of these IS this invoice, link it — otherwise it still needs entering.`,
      },
    },
    {
      type: 'actions',
      elements: i.candidates.slice(0, 3).map(b => ({
        type: 'button',
        action_id: `ap_link_manual_${b.uid}`,
        value: JSON.stringify({ r: i.rowId, u: b.uid, n: b.number || '' }),
        text: { type: 'plain_text', text: `🔗 Link bill #${b.number || '?'}`.slice(0, 75), emoji: true },
        confirm: {
          title: { type: 'plain_text', text: 'Link this bill?' },
          text: { type: 'mrkdwn', text: `Mark this invoice *posted manually*, linked to MYOB bill #${b.number || '?'}${b.date ? ` (${String(b.date).slice(0, 10)})` : ''}. The automation will stop chasing it.` },
          confirm: { type: 'plain_text', text: 'Link it' },
          deny: { type: 'plain_text', text: 'Cancel' },
        },
      })),
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Checked by ${i.checkedBy}` }] },
  ]
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

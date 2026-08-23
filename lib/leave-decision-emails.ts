// lib/leave-decision-emails.ts
// SERVER-ONLY. Emails the applicant when their leave application is decided on
// the monday.com board "Payroll & Leave Applications" (5027074711).
//
// Why this isn't a monday automation: monday can only send email through the
// Gmail/Outlook integration, which sends from one person's connected mailbox,
// dies silently when that connection lapses, and — fatally here — does nothing
// when the board's Email Address column is empty. That column is only filled
// when someone submits the Leave Request form; managers hand-create most rows
// ("Callan O", "Dan O", "Terry") with no address at all. So the portal polls
// instead and resolves the address itself.
//
// What counts as an application (Chris, 24 Aug 2026): "only items that have been
// in group Leave Applications and had Approved status pressed on it". The board
// doubles as a daily attendance log — "Kaleb Rowe left work at 11am today",
// "Public Holiday", "Easter Monday - all staff", "TIME OFF/OVERTIME EXPORT" all
// sit there marked Approved — and none of those should email anybody. The
// board's own automations make the rule checkable: pressing Approved on an item
// in Leave Applications moves it to "Upcoming Leave - Approved", and Denied
// moves it to "Leave Denied". Hand-created notes are created straight into the
// payroll groups and never pass through either. So we only act on items sitting
// in one of APPLICATION_GROUPS below.
//
// Address resolution, in order:
//   1. the board's Email Address column, unless it looks like a typo of our own
//      domain (a live row had `justaustosmechanical.com.au` — that bounces into
//      a void, so we'd rather fall through to the directory)
//   2. leave_staff_directory — name-as-typed-on-the-board -> email, editable in
//      Settings -> Leave Notifications. Tiered match: exact, then noise words
//      stripped ("Dom Simpson Sick"), then first+initial, then a lone first name
//      only when exactly one directory row starts with it
//   3. nothing — the row is logged `no_address`, HR is emailed once, and every
//      later run retries it (so adding the address is all HR has to do)
//
// Going live does NOT email history: on the very first run every already-decided
// item is written to leave_decision_emails as `baseline` and nothing is sent.
// After that, one row per (item, decision) is the dedupe key — flipping an item
// from Approved to Denied is a new decision and does email again.
//
// Settings (integration_settings, DB-first per lib/integration-config):
//   LEAVE_EMAILS_ENABLED  'false' switches the whole thing off without a deploy
//   LEAVE_HR_EMAIL        copied on every email, reply-to, and told when an
//                         address can't be resolved (default ryan@)

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { mondayQuery } from './monday-followup'
import { getIntegrations } from './integration-config'
import { sendMail } from './email'

export const LEAVE_BOARD_ID = '5027074711'
export const LEAVE_BOARD_URL = `https://just-autos.monday.com/boards/${LEAVE_BOARD_ID}`
const DEFAULT_HR_EMAIL = 'ryan@justautosmechanical.com.au'
const OUR_DOMAIN = 'justautosmechanical.com.au'

// Column ids on the board (get_board_info, 24 Aug 2026). The approval column is
// titled "Leave Approved" and carries Approved / Denied / Working on it.
const COL = {
  approval: 'color_mkqzmrz1',
  email: 'emailyt2fk0ds',
  start: 'datez0cq280z',
  end: 'datep4xcejla',
  days: 'numberwr0oj6bc',
  classification: 'single_selectvzfbv3d',
  department: 'color_mkqz7qj9',
} as const

// The application path. `topics` = "Leave Applications" (where the form drops
// them, and where an approval pressed within the same 15-minute window is still
// sitting); the other two are where the board's automations move an item the
// moment Approved / Denied is pressed on it. Anything in the payroll groups is
// either an attendance note or a row a manager keyed straight into payroll —
// neither is an application, so neither emails.
const APPLICATION_GROUPS = new Set(['topics', 'group_mkqz6qh6', 'group_mkqzjmed'])

export type Decision = 'approved' | 'denied'
export type SendStatus = 'baseline' | 'sent' | 'no_address' | 'failed'

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  _sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  return _sb
}

// ── name normalisation & directory matching ──────────────────────────────

/** Lower-case, punctuation stripped, whitespace collapsed. */
export function normaliseName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Words managers append to the applicant's name on the board ("Dom Simpson
// Sick", "Chris R annual leave"). Stripped from the tail before matching.
const NOISE = new Set([
  'sick', 'leave', 'annual', 'personal', 'carers', 'compassionate', 'unpaid',
  'overtime', 'toil', 'holiday', 'rdo', 'day', 'days', 'half', 'off', 'am', 'pm',
  'time', 'in', 'lieu', 'leau', 'casual', 'request', 'application',
])

function stripNoise(key: string): string {
  const parts = key.split(' ')
  while (parts.length > 1 && NOISE.has(parts[parts.length - 1])) parts.pop()
  return parts.join(' ')
}

export interface DirectoryEntry { match_key: string; match_name: string; email: string }

/**
 * Resolve a board item name to a directory email. Tiers, most specific first —
 * a lone first name only wins when exactly one directory row starts with it, so
 * "Matt" (Huddy or Smith) stays unresolved rather than guessed.
 */
export function matchDirectory(itemName: string, dir: DirectoryEntry[]): DirectoryEntry | null {
  const byKey = new Map(dir.map(d => [d.match_key, d]))
  const full = normaliseName(itemName)
  if (!full) return null

  const candidates = [full, stripNoise(full)]
  const parts = stripNoise(full).split(' ').filter(Boolean)
  if (parts.length >= 2) {
    candidates.push(`${parts[0]} ${parts[1]}`)          // "dom simpson"
    candidates.push(`${parts[0]} ${parts[1][0]}`)       // "dom s"
  }
  for (const c of candidates) {
    const hit = byKey.get(c)
    if (hit) return hit
  }
  // Lone first name — only if unambiguous, and only if the name names ONE
  // person. "James, Kaleb, Graham, Dom and Tyronne" (a real row) would
  // otherwise match on its first word and email James alone as though the whole
  // thing were his application.
  if (parts.length >= 1) {
    const tokens = new Set(parts)
    const mentioned = new Set(
      dir.filter(d => tokens.has(d.match_key.split(' ')[0])).map(d => d.email.toLowerCase()),
    )
    if (mentioned.size > 1) return null

    const first = parts[0]
    const starts = dir.filter(d => d.match_key === first || d.match_key.startsWith(first + ' '))
    const emails = new Set(starts.map(s => s.email.toLowerCase()))
    if (starts.length && emails.size === 1) return starts[0]
  }
  return null
}

// ── suspect address detection ────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * An address is "suspect" when its domain is a near-miss of ours — the live row
 * `jarred@justaustosmechanical.com.au` would bounce with nobody watching. Any
 * other domain (a personal hotmail/gmail) is taken at face value.
 */
export function isSuspectAddress(email: string): boolean {
  const domain = String(email || '').split('@')[1]?.toLowerCase().trim()
  if (!domain) return true
  if (domain === OUR_DOMAIN) return false
  const d = levenshtein(domain, OUR_DOMAIN)
  return d > 0 && d <= 3
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

// ── monday board read ────────────────────────────────────────────────────

export interface LeaveItem {
  id: string
  name: string
  url: string
  groupId: string | null
  group: string | null
  decision: Decision | null
  columnEmail: string | null
  start: string | null
  end: string | null
  days: string | null
  classification: string | null
  department: string | null
}

const colText = (item: any, id: string): string | null => {
  const v = (item.column_values || []).find((c: any) => c.id === id)?.text
  const s = String(v ?? '').trim()
  return s || null
}

export async function fetchLeaveItems(): Promise<LeaveItem[]> {
  const colIds = Object.values(COL).map(c => `"${c}"`).join(',')
  const out: LeaveItem[] = []
  let cursor: string | null = null
  // The board holds ~250 items; 20 × 200 is a runaway guard, not a real cap.
  for (let page = 0; page < 20; page++) {
    const cursorArg: string = cursor ? `cursor: "${cursor}"` : ''
    const data = await mondayQuery<any>(`query { boards(ids: [${LEAVE_BOARD_ID}]) {
      items_page(limit: 200${cursorArg ? ', ' + cursorArg : ''}) {
        cursor
        items { id name url group { id title } column_values(ids: [${colIds}]) { id text } }
      }
    } }`)
    const pageData: any = data?.boards?.[0]?.items_page
    const items: any[] = pageData?.items || []
    for (const it of items) {
      const approval = colText(it, COL.approval)
      out.push({
        id: String(it.id),
        name: String(it.name || '').trim(),
        url: String(it.url || `${LEAVE_BOARD_URL}/pulses/${it.id}`),
        groupId: it.group?.id || null,
        group: it.group?.title || null,
        decision: approval === 'Approved' ? 'approved' : approval === 'Denied' ? 'denied' : null,
        columnEmail: colText(it, COL.email),
        start: colText(it, COL.start),
        end: colText(it, COL.end),
        days: colText(it, COL.days),
        classification: colText(it, COL.classification),
        department: colText(it, COL.department),
      })
    }
    cursor = pageData?.cursor || null
    if (!cursor || !items.length) break
  }
  return out
}

/** Best-effort audit note on the monday item. Never fails the send. */
async function postMondayUpdate(itemId: string, body: string): Promise<void> {
  try {
    await mondayQuery(`mutation { create_update(item_id: ${itemId}, body: ${JSON.stringify(body)}) { id } }`)
  } catch (e: any) {
    console.warn('[leave-emails] monday update failed for', itemId, e?.message || e)
  }
}

// ── email bodies ─────────────────────────────────────────────────────────

function esc(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
}

function firstName(name: string): string {
  const p = String(name || '').trim().split(/\s+/)[0]
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : 'there'
}

function shell(inner: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:640px;margin:0 auto">
    <div style="border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:16px;font-size:18px;font-weight:700">Just Autos</div>
    ${inner}
    <div style="border-top:1px solid #eee;margin-top:20px;padding-top:10px;color:#888;font-size:12px">Just Autos Mechanical · Sent automatically by the Just Autos portal.</div>
  </div>`
}

function detailsTable(item: LeaveItem): string {
  const rows: Array<[string, string]> = [
    ['Leave type', item.classification || '—'],
    ['Start', fmtDate(item.start)],
    ['End', fmtDate(item.end)],
    ['Total days', item.days || '—'],
  ]
  return `<table style="border-collapse:collapse;margin:0 0 16px">${rows.map(([k, v]) => `
    <tr>
      <td style="padding:4px 16px 4px 0;color:#666">${esc(k)}</td>
      <td style="padding:4px 0;font-weight:600">${esc(v)}</td>
    </tr>`).join('')}</table>`
}

function dateSpan(item: LeaveItem): string {
  if (item.start && item.end && item.start !== item.end) return `${fmtDate(item.start)} – ${fmtDate(item.end)}`
  return fmtDate(item.start || item.end)
}

export function buildDecisionEmail(item: LeaveItem, decision: Decision, hrEmail: string): { subject: string; html: string } {
  if (decision === 'approved') {
    return {
      subject: `Leave approved — ${dateSpan(item)}`,
      html: shell(`
        <p style="line-height:1.6;margin:0 0 12px">Hi ${esc(firstName(item.name))},</p>
        <p style="line-height:1.6;margin:0 0 16px">Your leave application has been <strong>approved</strong>.</p>
        ${detailsTable(item)}
        <p style="line-height:1.6;margin:0 0 12px">Nothing further to do — payroll will pick it up from here. If your plans change, or any of the detail above is wrong, reply to this email or speak to your manager before the start date.</p>
        <p style="line-height:1.6;margin:0">Thanks,<br/>Just Autos</p>`),
    }
  }
  return {
    subject: `Leave application — not approved (${dateSpan(item)})`,
    html: shell(`
      <p style="line-height:1.6;margin:0 0 12px">Hi ${esc(firstName(item.name))},</p>
      <p style="line-height:1.6;margin:0 0 16px">Your leave application has <strong>not been approved</strong> on this occasion.</p>
      ${detailsTable(item)}
      <p style="line-height:1.6;margin:0 0 12px">Please don't take this leave. Have a chat with your manager — or reply to this email (it reaches ${esc(hrEmail)}) — and we'll work out what can be done, including other dates that might suit.</p>
      <p style="line-height:1.6;margin:0">Thanks,<br/>Just Autos</p>`),
  }
}

function buildNoAddressEmail(item: LeaveItem, decision: Decision): { subject: string; html: string } {
  return {
    subject: `Leave ${decision} — no email address for ${item.name || 'applicant'}`,
    html: shell(`
      <p style="line-height:1.6;margin:0 0 12px">This leave application was marked <strong>${esc(decision)}</strong>, but the portal couldn't work out where to email the applicant.</p>
      ${detailsTable(item)}
      <p style="line-height:1.6;margin:0 0 12px"><strong>Applicant as typed on the board:</strong> ${esc(item.name || '(blank)')}</p>
      <p style="line-height:1.6;margin:0 0 12px">Fix it either way and the next run (every 15 minutes) sends it automatically — no need to re-approve:</p>
      <ul style="line-height:1.6;margin:0 0 12px;padding-left:20px">
        <li>fill in the <strong>Email Address</strong> column on <a href="${esc(item.url)}" style="color:#4f8ef7">the item</a>, or</li>
        <li>add the name to the staff directory in the portal under <strong>Settings → Leave Notifications</strong>.</li>
      </ul>
      <p style="line-height:1.6;margin:0">You'll only get this notice once per application.</p>`),
  }
}

// ── the run ──────────────────────────────────────────────────────────────

export interface RunSummary {
  enabled: boolean
  scanned: number
  decided: number
  /** Decided items ignored because they're not on the application path. */
  notApplications: number
  seeded: number
  sent: number
  noAddress: number
  failed: number
  skipped: number
  details: Array<{ item: string; name: string; decision: Decision; status: SendStatus; to?: string | null; error?: string }>
}

export async function runLeaveDecisionEmails(opts: { dryRun?: boolean } = {}): Promise<RunSummary> {
  const cfg = await getIntegrations(['LEAVE_EMAILS_ENABLED', 'LEAVE_HR_EMAIL'])
  const hrEmail = (cfg.LEAVE_HR_EMAIL || DEFAULT_HR_EMAIL).toLowerCase()
  const summary: RunSummary = { enabled: true, scanned: 0, decided: 0, notApplications: 0, seeded: 0, sent: 0, noAddress: 0, failed: 0, skipped: 0, details: [] }

  if (String(cfg.LEAVE_EMAILS_ENABLED || 'true').toLowerCase() === 'false') {
    return { ...summary, enabled: false }
  }

  const items = await fetchLeaveItems()
  summary.scanned = items.length
  // Decided AND on the application path — see APPLICATION_GROUPS. Everything
  // else on this board (attendance notes, public holidays, payroll keying) is
  // ignored outright: no email, no log row, no HR notice.
  const decided = items.filter(i => i.decision && i.groupId && APPLICATION_GROUPS.has(i.groupId))
  summary.decided = decided.length
  summary.notApplications = items.filter(i => i.decision && !(i.groupId && APPLICATION_GROUPS.has(i.groupId))).length
  if (!decided.length) return summary

  // Existing log rows for these items (dedupe + retry set).
  const ids = decided.map(i => i.id)
  const existing = new Map<string, any>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb().from('leave_decision_emails')
      .select('id, monday_item_id, decision, status, hr_notified_at, attempts')
      .in('monday_item_id', ids.slice(i, i + 200))
    if (error) throw new Error(`leave_decision_emails read failed: ${error.message}`)
    for (const r of data || []) existing.set(`${r.monday_item_id}:${r.decision}`, r)
  }

  // First ever run: baseline everything already decided, send nothing. Without
  // this, going live emails every historical approval on the board.
  const { count, error: countErr } = await sb().from('leave_decision_emails').select('id', { count: 'exact', head: true })
  if (countErr) throw new Error(`leave_decision_emails count failed: ${countErr.message}`)
  if (!count) {
    const rows = decided.map(i => ({
      monday_item_id: i.id, decision: i.decision as Decision, applicant_name: i.name,
      status: 'baseline' as SendStatus, leave_start: i.start, leave_end: i.end,
      classification: i.classification, total_days: i.days,
    }))
    if (!opts.dryRun) {
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await sb().from('leave_decision_emails').insert(rows.slice(i, i + 200))
        if (error) throw new Error(`baseline seed failed: ${error.message}`)
      }
    }
    summary.seeded = rows.length
    console.log(`[leave-emails] baseline seeded ${rows.length} already-decided applications — none emailed`)
    return summary
  }

  const dir = await loadDirectory()

  for (const item of decided) {
    const decision = item.decision as Decision
    const key = `${item.id}:${decision}`
    const prior = existing.get(key)
    // Already handled, unless it's still waiting on an address or failed.
    if (prior && !['no_address', 'failed'].includes(prior.status)) { summary.skipped++; continue }

    const resolved = resolveAddress(item, dir)
    const base = {
      monday_item_id: item.id, decision, applicant_name: item.name,
      leave_start: item.start, leave_end: item.end,
      classification: item.classification, total_days: item.days,
      updated_at: new Date().toISOString(),
    }

    if (!resolved) {
      summary.noAddress++
      summary.details.push({ item: item.id, name: item.name, decision, status: 'no_address' })
      if (opts.dryRun) continue
      const notifyHr = !prior?.hr_notified_at
      if (notifyHr) {
        try {
          const m = buildNoAddressEmail(item, decision)
          await sendMail(hrEmail, { to: [hrEmail], subject: m.subject, html: m.html, replyTo: hrEmail })
        } catch (e: any) {
          console.error('[leave-emails] HR no-address notice failed:', e?.message || e)
        }
      }
      await upsertLog({
        ...base, status: 'no_address', email_to: null, email_source: null,
        error: 'No address on the item and no directory match',
        attempts: (prior?.attempts || 0) + 1,
        hr_notified_at: prior?.hr_notified_at || (notifyHr ? new Date().toISOString() : null),
      })
      continue
    }

    if (opts.dryRun) {
      summary.sent++
      summary.details.push({ item: item.id, name: item.name, decision, status: 'sent', to: resolved.email })
      continue
    }

    const mail = buildDecisionEmail(item, decision, hrEmail)
    try {
      await sendMail(hrEmail, {
        to: [resolved.email],
        cc: [hrEmail],
        subject: mail.subject,
        html: mail.html,
        replyTo: hrEmail,
      })
      await upsertLog({
        ...base, status: 'sent', email_to: resolved.email, email_source: resolved.source,
        error: null, attempts: (prior?.attempts || 0) + 1, sent_at: new Date().toISOString(),
        hr_notified_at: prior?.hr_notified_at || null,
      })
      await postMondayUpdate(item.id,
        `📧 ${decision === 'approved' ? 'Approval' : 'Decline'} email sent to ${resolved.email}` +
        `${resolved.source === 'directory' ? ' (address from the portal staff directory)' : ''} — copy to ${hrEmail}.`)
      summary.sent++
      summary.details.push({ item: item.id, name: item.name, decision, status: 'sent', to: resolved.email })
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 400)
      await upsertLog({
        ...base, status: 'failed', email_to: resolved.email, email_source: resolved.source,
        error: msg, attempts: (prior?.attempts || 0) + 1,
        hr_notified_at: prior?.hr_notified_at || null,
      })
      summary.failed++
      summary.details.push({ item: item.id, name: item.name, decision, status: 'failed', to: resolved.email, error: msg })
      console.error('[leave-emails] send failed for', item.id, msg)
    }
  }

  return summary
}

async function upsertLog(row: Record<string, any>): Promise<void> {
  const { error } = await sb().from('leave_decision_emails')
    .upsert(row, { onConflict: 'monday_item_id,decision' })
  if (error) throw new Error(`leave_decision_emails write failed: ${error.message}`)
}

export async function loadDirectory(): Promise<DirectoryEntry[]> {
  const { data, error } = await sb().from('leave_staff_directory').select('match_key, match_name, email')
  if (error) throw new Error(`leave_staff_directory read failed: ${error.message}`)
  return (data || []) as DirectoryEntry[]
}

export interface ResolvedAddress { email: string; source: 'column' | 'directory' }

export function resolveAddress(item: LeaveItem, dir: DirectoryEntry[]): ResolvedAddress | null {
  const col = String(item.columnEmail || '').trim()
  if (col && EMAIL_RE.test(col) && !isSuspectAddress(col)) return { email: col, source: 'column' }
  const hit = matchDirectory(item.name, dir)
  if (hit && EMAIL_RE.test(hit.email)) return { email: hit.email, source: 'directory' }
  // A misspelt-domain address is deliberately NOT used as a last resort: it
  // bounces into a void and everyone believes the applicant was told. Better to
  // report it as unresolved and have HR correct the address.
  return null
}

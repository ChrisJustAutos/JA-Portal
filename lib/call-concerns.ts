// lib/call-concerns.ts
// Negative-call automation (migration 155).
//
// Two sweeps, both driven from the calls-analyse cron (*/5):
//
//   runConcernSweep()     — examine freshly transcribed INBOUND calls once
//     each (calls.concern_checked_at) with a cheap second Claude pass: is
//     this a complaint / concern / support issue? If yes → insert a
//     call_concerns row, post a card to the negative Slack channel (caller,
//     advisor, summary, action items, Mark-actioned button) and thread the
//     customer's MechanicDesk job history underneath (workshop_customers
//     phone match → md_id → md_invoices).
//
//   runConcernFollowups() — for concerns past followup_due_at (default 3
//     days) with no detected contact: tag the advisor in the thread asking
//     if it's been actioned (re-nudged daily) and email Matt once. Contact =
//     an outbound CDR call to the customer's number after detection, or a
//     sent email to the customer's address from any active staff mailbox
//     (Graph sent-items, best-effort). Contact found → ✅ thread note, done.
//
// The Slack "Mark actioned" button (action_id concern_actioned) is handled
// in pages/api/slack/ask.ts → markConcernActioned().

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { postMessage } from './slack-bot/slack'
import { sendMail } from './email'
import { sentMailToSince } from './microsoft-graph'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'

const CHANNEL = process.env.CONCERN_SLACK_CHANNEL || 'G01GB6P2MU1' // #customer-feedback-negative
const FOLLOWUP_DAYS = Math.max(1, Number(process.env.CONCERN_FOLLOWUP_DAYS) || 3)
const ESCALATION_EMAIL = process.env.CONCERN_ESCALATION_EMAIL || 'Matt.h@justautosmechanical.com.au'
const MIN_SECONDS = 40           // ignore very short calls
const NUDGE_GAP_HOURS = 20       // "daily" re-nudge guard
const PORTAL_URL = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://justautos.app'

export function concernsEnabled(): boolean {
  // Re-enabled 2026-07-13 after the genuine-issue rework: only faults
  // attributable to Just Autos work post to Slack; near-misses are recorded
  // in call_concerns (genuine=false) without posting.
  return (process.env.CALL_CONCERNS_ENABLED || 'true').toLowerCase() !== 'false'
}

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env not configured')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Detection prompt ───────────────────────────────────────────────────────

function concernPrompt(transcript: string, meta: { callerName: string | null; agentName: string | null; durationSec: number }): string {
  return `You are reviewing a phone call to Just Autos, a 4x4 mechanical workshop on the Sunshine Coast (engine builds, tunes, GVM upgrades, servicing on LandCruisers/Hiluxes etc.). Your job is to catch GENUINE ISSUES WITH WORK JUST AUTOS HAS DONE — and nothing else.

Flag the call ONLY if BOTH of these are true:
  Q1. The customer reports something WRONG or UNRESOLVED — a fault, defect, recurring problem, damage, dissatisfaction, or a consequence they're facing. NOT a question, NOT a request for advice, NOT a status check, NOT a price/booking enquiry.
  Q2. The problem is attributable to work Just Autos PERFORMED or a product Just Autos SUPPLIED/INSTALLED (engine, tune, parts, accessories — whenever it was done).

Both yes → flag. Anything else → do not flag.

Real examples of calls that MUST be flagged:
- "200 Series puffing white smoke at speed ever since Just Autos installed the new engine and tune" → YES (fault, our work).
- "Car is still playing up after the work; customer has video for the technician" → YES (unresolved fault, our work).
- "Our tune/ECU update made the car run poorly and use more fuel" → YES even if partially resolved (fault, our work).
- "Police flagged the vehicle over the DPF delete we performed; customer expects an inspection notice" → YES (serious consequence of our work).

Real examples that must NOT be flagged:
- "Toyota dealer recommends an injector clean on my tuned car — should I let them?" → NO (advice question; nothing wrong).
- "How do I handle these Toyota recall notices on my tuned 300 Series?" → NO (advice question).
- "Checking my car's ready for pickup tomorrow" → NO (status check).
- "Toyota dismissed my warranty issue; I'm interested in one of your tunes" → NO (their problem is with ANOTHER company; to us it's a sales enquiry).
- "Graham promised to send me photos of the job — can someone send them?" → NO (unmet promise, but nothing wrong with the work).
- Bookings, quotes, parts availability, suppliers, telemarketers, wrong numbers → NO.

Category (only when flagged): "complaint" if the customer is unhappy/frustrated with Just Autos; "concern" if something seems wrong but they're calm; "support" if they face external consequences of our work (like the police/DPF case).

Call metadata: caller ${meta.callerName || 'unknown'}, staff member ${meta.agentName || 'unknown'}, duration ${Math.round(meta.durationSec)}s.

Transcript (S0/S1... are speakers; decide who is staff vs customer from content):
${transcript.slice(0, 24000)}

Respond with ONLY a JSON object:
{
  "is_issue": true|false,          // Q1: something wrong/unresolved reported
  "about_our_work": true|false,    // Q2: attributable to Just Autos work/product
  "category": "complaint"|"concern"|"support"|null,
  "severity": "low"|"medium"|"high"|null,
  "confidence": "high"|"medium"|"low",   // how sure you are of the flag decision
  "customer_name": "name if stated in the call, else null",
  "summary": "2-3 sentences: what the customer's issue is and any commitments staff made",
  "action_items": ["specific actions someone must take, e.g. 'Call John back with the warranty claim outcome'"]
}`
}

function extractJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1))
  throw new Error('no JSON object in model output')
}

async function callClaude(prompt: string): Promise<any> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`)
  const data = await r.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('empty model response')
  return extractJson(text)
}

// ── Customer + MD history matching ─────────────────────────────────────────

const digits = (s: string | null | undefined) => String(s || '').replace(/\D/g, '')

async function matchCustomer(phone: string | null): Promise<{ id: string; name: string | null; email: string | null; mdId: string | null } | null> {
  const d = digits(phone)
  if (d.length < 8) return null
  const tail = d.slice(-8) // AU numbers: last 8 digits survive +61/0 prefix differences
  const { data: rows } = await sb()
    .from('workshop_customers')
    .select('id, name, email, md_id, phone, mobile')
    .or(`phone.ilike.%${tail},mobile.ilike.%${tail}`)
    .limit(5)
  const hit = (rows || []).find(r => digits(r.phone).endsWith(tail) || digits(r.mobile).endsWith(tail))
  if (!hit) return null
  return { id: hit.id, name: hit.name, email: hit.email || null, mdId: hit.md_id || null }
}

interface MdJob { invoice_number: string; issue_date: string | null; rego: string | null; description: string | null; total_amount: number }

async function mdJobHistory(mdId: string | null, customerName: string | null): Promise<MdJob[]> {
  const c = sb()
  if (mdId) {
    const { data } = await c.from('md_invoices')
      .select('invoice_number, issue_date, rego, description, total_amount')
      .eq('customer_id', mdId)
      .order('issue_date', { ascending: false })
      .limit(5)
    if (data?.length) return data as MdJob[]
  }
  if (customerName && customerName.trim().length >= 5) {
    const { data } = await c.from('md_invoices')
      .select('invoice_number, issue_date, rego, description, total_amount')
      .ilike('customer_name', customerName.trim())
      .order('issue_date', { ascending: false })
      .limit(5)
    if (data?.length) return data as MdJob[]
  }
  return []
}

// ── Slack cards ────────────────────────────────────────────────────────────

const CAT_EMOJI: Record<string, string> = { complaint: '🔴', concern: '🟠', support: '🔵' }

function concernBlocks(row: {
  id: string; category: string; severity: string; summary: string; action_items: string[]
  caller: string; advisor: string; when: string; durationSec: number; callId: string; callYmd: string
}): any[] {
  const items = row.action_items.length ? row.action_items.map(a => `• ${a}`).join('\n') : '_none extracted_'
  return [
    { type: 'header', text: { type: 'plain_text', text: `${CAT_EMOJI[row.category] || '🟠'} ${row.category[0].toUpperCase()}${row.category.slice(1)} — ${row.caller}` } },
    {
      type: 'section', fields: [
        { type: 'mrkdwn', text: `*Caller:*\n${row.caller}` },
        { type: 'mrkdwn', text: `*Taken by:*\n${row.advisor}` },
        { type: 'mrkdwn', text: `*When:*\n${row.when}` },
        { type: 'mrkdwn', text: `*Duration / severity:*\n${Math.round(row.durationSec / 60)} min · ${row.severity}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*What happened*\n${row.summary}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Action items*\n${items}` } },
    {
      type: 'actions', elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✓ Mark actioned' }, action_id: 'concern_actioned', value: row.id },
        { type: 'button', text: { type: 'plain_text', text: '📱 Approve text to customer' }, action_id: 'concern_send_sms', value: row.id },
        { type: 'button', text: { type: 'plain_text', text: 'Open in Calls' }, url: `${PORTAL_URL}/calls?call=${row.callId}&date=${row.callYmd}` },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Follow-up check in ${FOLLOWUP_DAYS} days — I'll confirm the customer has been called or emailed, and nudge here if not.` }] },
  ]
}

function historyText(jobs: MdJob[], customerName: string | null): string {
  if (!jobs.length) return `📋 No MechanicDesk job history found for this number${customerName ? ` (${customerName})` : ''}.`
  const lines = jobs.map(j => {
    const d = j.issue_date ? new Date(j.issue_date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
    const desc = (j.description || '').replace(/\s+/g, ' ').slice(0, 90)
    return `• *${d}* — #${j.invoice_number}${j.rego ? ` · ${j.rego}` : ''} · $${Number(j.total_amount).toLocaleString()}${desc ? `\n    _${desc}_` : ''}`
  })
  return `📋 *MechanicDesk history — ${customerName || 'matched customer'}* (last ${jobs.length} jobs)\n${lines.join('\n')}`
}

// ── Sweep 1: detection ─────────────────────────────────────────────────────

export interface ConcernSweepOutcome {
  enabled: boolean
  checked: number
  flagged: { callId: string; category: string; slackTs: string | null }[]
  errors: string[]
}

export async function runConcernSweep(opts: { limit?: number; dryRun?: boolean } = {}): Promise<ConcernSweepOutcome> {
  const c = sb()
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 20))
  const out: ConcernSweepOutcome = { enabled: concernsEnabled(), checked: 0, flagged: [], errors: [] }
  if (!out.enabled && !opts.dryRun) return out

  // Recent inbound transcribed calls not yet examined. Transcripts live in
  // call_transcripts (calls.transcript_text is a dead legacy mirror — 0 rows
  // populated); join like the coaching sweep does. The 3-day window keeps
  // the first deploy from trawling history.
  const { data: candidateRows } = await c.from('calls')
    .select('id, call_date, direction, external_number, external_number_normalised, caller_name, agent_name, effective_advisor_name, effective_advisor_slack_user_id, billsec_seconds, duration_seconds, call_transcripts!inner(full_text, segments)')
    .eq('direction', 'inbound')
    .is('concern_checked_at', null)
    .gte('call_date', new Date(Date.now() - 3 * 86400e3).toISOString())
    .order('call_date', { ascending: false })
    .limit(limit)

  const candidates = (candidateRows || []).map((r: any) => {
    const t = Array.isArray(r.call_transcripts) ? r.call_transcripts[0] : r.call_transcripts
    const segs = Array.isArray(t?.segments) ? t.segments : null
    const lines = segs?.map((s: any) => {
      const text = (s.text || s.transcript || '').trim()
      return text ? `S${s.speaker ?? s.speaker_id ?? '?'}: ${text}` : null
    }).filter(Boolean)
    return { ...r, transcript_text: (lines?.length ? lines.join('\n') : t?.full_text) || null }
  })

  for (const call of candidates) {
    const secs = call.billsec_seconds || call.duration_seconds || 0
    try {
      if (secs < MIN_SECONDS || !(call.transcript_text || '').trim()) {
        if (!opts.dryRun) await c.from('calls').update({ concern_checked_at: new Date().toISOString() }).eq('id', call.id)
        continue
      }
      out.checked++
      const parsed = await callClaude(concernPrompt(call.transcript_text, {
        callerName: call.caller_name || call.external_number,
        agentName: call.effective_advisor_name || call.agent_name,
        durationSec: secs,
      }))
      if (!opts.dryRun) await c.from('calls').update({ concern_checked_at: new Date().toISOString() }).eq('id', call.id)

      const category = ['complaint', 'concern', 'support'].includes(parsed?.category) ? parsed.category : null
      const confidence = ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'medium'
      const isIssue = !!parsed?.is_issue
      const aboutOurWork = !!parsed?.about_our_work
      // GENUINE = something is wrong AND it's about our work AND the model is
      // reasonably sure. Only genuine issues post to Slack + get the chase;
      // near-misses are recorded (genuine=false, dismissed) for later review.
      const genuine = isIssue && aboutOurWork && !!category && confidence !== 'low'
      const nearMiss = !genuine && (isIssue || aboutOurWork) && !!category
      if (!genuine && !nearMiss) continue
      if (opts.dryRun) { out.flagged.push({ callId: call.id, category: `${category}${genuine ? '' : ' (near-miss, not posted)'}`, slackTs: null }); continue }

      const severity = ['low', 'medium', 'high'].includes(parsed?.severity) ? parsed.severity : 'medium'
      const actionItems: string[] = Array.isArray(parsed?.action_items) ? parsed.action_items.map(String).slice(0, 8) : []
      const customer = await matchCustomer(call.external_number_normalised || call.external_number)
      const callerLabel = customer?.name || parsed?.customer_name || call.caller_name || call.external_number || 'Unknown caller'

      const { data: ins, error: insErr } = await c.from('call_concerns').insert({
        call_id: call.id,
        category, severity,
        genuine, confidence,
        summary: String(parsed.summary || '').slice(0, 2000),
        action_items: actionItems,
        customer_phone: call.external_number_normalised || call.external_number,
        customer_name: callerLabel,
        customer_email: customer?.email || null,
        workshop_customer_id: customer?.id || null,
        md_customer_id: customer?.mdId || null,
        advisor_name: call.effective_advisor_name || call.agent_name,
        advisor_slack_user_id: call.effective_advisor_slack_user_id,
        followup_due_at: new Date(Date.now() + FOLLOWUP_DAYS * 86400e3).toISOString(),
        ...(genuine ? {} : { followup_status: 'dismissed', followup_note: 'near-miss: not a genuine our-work issue — recorded only' }),
      }).select('id').single()
      if (insErr) {
        // unique(call_id) — already flagged by an overlapping run
        if (!String(insErr.message).includes('duplicate')) out.errors.push(`${call.id}: ${insErr.message}`)
        continue
      }
      if (!genuine) continue // near-miss recorded, no Slack, no chase

      const when = new Date(call.call_date).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      const post = await postMessage({
        channel: CHANNEL,
        text: `${CAT_EMOJI[category]} ${category}: ${callerLabel} — ${String(parsed.summary || '').slice(0, 140)}`,
        blocks: concernBlocks({
          id: ins.id, category, severity,
          summary: String(parsed.summary || ''),
          action_items: actionItems,
          caller: `${callerLabel}${call.external_number ? ` (${call.external_number})` : ''}`,
          advisor: call.effective_advisor_name || call.agent_name || 'Unknown',
          when, durationSec: secs, callId: call.id,
          callYmd: new Date(call.call_date).toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' }),
        }),
      })
      if (post?.ts) {
        await c.from('call_concerns').update({ slack_channel: post.channel, slack_ts: post.ts }).eq('id', ins.id)
        const jobs = await mdJobHistory(customer?.mdId || null, customer?.name || null)
        await postMessage({ channel: post.channel, thread_ts: post.ts, text: historyText(jobs, customer?.name || null) })
      }
      out.flagged.push({ callId: call.id, category, slackTs: post?.ts || null })
    } catch (e: any) {
      out.errors.push(`${call.id}: ${(e?.message || e).toString().slice(0, 200)}`)
    }
  }
  return out
}

// ── Sweep 2: follow-ups ────────────────────────────────────────────────────

export interface FollowupOutcome {
  due: number
  contactDetected: number
  nudged: number
  mattEmailed: number
  errors: string[]
}

async function staffMailboxes(): Promise<string[]> {
  const { data } = await sb().from('user_profiles').select('email').eq('is_active', true)
  return (data || []).map(r => String(r.email || '')).filter(e => e.includes('@justautos'))
}

async function detectContact(concern: any): Promise<string | null> {
  const c = sb()
  // 1. Outbound call to the customer's number after detection (any answered leg)
  const tail = digits(concern.customer_phone).slice(-8)
  if (tail.length === 8) {
    const { data: outCalls } = await c.from('calls')
      .select('id, call_date, agent_name, billsec_seconds, external_number_normalised')
      .eq('direction', 'outbound')
      .gte('call_date', concern.detected_at)
      .gte('billsec_seconds', 20)
      .like('external_number_normalised', `%${tail}`)
      .order('call_date', { ascending: true })
      .limit(1)
    if (outCalls?.length) {
      const d = new Date(outCalls[0].call_date).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
      return `outbound call ${d}${outCalls[0].agent_name ? ` by ${outCalls[0].agent_name}` : ''}`
    }
  }
  // 2. Email sent to the customer from any active staff mailbox (best-effort)
  if (concern.customer_email) {
    for (const mb of await staffMailboxes()) {
      try {
        if (await sentMailToSince(mb, concern.customer_email, concern.detected_at)) return `email from ${mb}`
      } catch { /* mailbox unreadable — skip */ }
    }
  }
  return null
}

export async function runConcernFollowups(): Promise<FollowupOutcome> {
  const c = sb()
  const out: FollowupOutcome = { due: 0, contactDetected: 0, nudged: 0, mattEmailed: 0, errors: [] }
  if (!concernsEnabled()) return out

  const { data: due } = await c.from('call_concerns')
    .select('*')
    .in('followup_status', ['pending', 'nudging'])
    .lte('followup_due_at', new Date().toISOString())
    .limit(20)

  for (const concern of due || []) {
    out.due++
    try {
      const contact = await detectContact(concern)
      if (contact) {
        await c.from('call_concerns').update({
          followup_status: 'contact_detected',
          followup_note: contact,
          actioned_at: new Date().toISOString(),
        }).eq('id', concern.id)
        if (concern.slack_channel && concern.slack_ts) {
          await postMessage({ channel: concern.slack_channel, thread_ts: concern.slack_ts, text: `✅ Follow-up detected: ${contact}. Closing this one off.` })
        }
        out.contactDetected++
        continue
      }

      // No contact — nudge (max once per NUDGE_GAP_HOURS), email Matt once.
      const lastNudge = concern.last_nudge_at ? new Date(concern.last_nudge_at).getTime() : 0
      if (Date.now() - lastNudge < NUDGE_GAP_HOURS * 3600e3) continue

      const who = concern.advisor_slack_user_id ? `<@${concern.advisor_slack_user_id}>` : (concern.advisor_name || 'team')
      if (concern.slack_channel && concern.slack_ts) {
        await postMessage({
          channel: concern.slack_channel, thread_ts: concern.slack_ts,
          text: `⏰ ${who} — no call or email to ${concern.customer_name || 'this customer'} has shown up since this ${concern.category} (${FOLLOWUP_DAYS}+ days). Has it been actioned? Hit "Mark actioned" on the card above if so.`,
        })
      }
      const updates: any = { followup_status: 'nudging', last_nudge_at: new Date().toISOString() }
      if (!concern.matt_emailed_at) {
        try {
          const items = (Array.isArray(concern.action_items) ? concern.action_items : []).map((a: string) => `<li>${a}</li>`).join('')
          await sendMail(ESCALATION_EMAIL, {
            to: [ESCALATION_EMAIL],
            subject: `Outstanding ${concern.category}: ${concern.customer_name || concern.customer_phone || 'customer'} — no follow-up after ${FOLLOWUP_DAYS} days`,
            html: `<p>A customer ${concern.category} from ${new Date(concern.detected_at).toLocaleDateString('en-AU')} has had no detected follow-up (no outbound call or email).</p>
<p><b>Customer:</b> ${concern.customer_name || 'Unknown'} (${concern.customer_phone || 'no number'})<br/>
<b>Taken by:</b> ${concern.advisor_name || 'Unknown'}<br/>
<b>Severity:</b> ${concern.severity}</p>
<p><b>Summary:</b> ${concern.summary}</p>
${items ? `<p><b>Action items:</b></p><ul>${items}</ul>` : ''}
<p>Slack thread: see #customer-feedback-negative. The advisor has been tagged there.</p>`,
          })
          updates.matt_emailed_at = new Date().toISOString()
          out.mattEmailed++
        } catch (e: any) {
          out.errors.push(`email ${concern.id}: ${(e?.message || e).toString().slice(0, 150)}`)
        }
      }
      await c.from('call_concerns').update(updates).eq('id', concern.id)
      out.nudged++
    } catch (e: any) {
      out.errors.push(`${concern.id}: ${(e?.message || e).toString().slice(0, 200)}`)
    }
  }
  return out
}

// ── Slack button: Approve acknowledgement SMS ──────────────────────────────
// Human-in-the-loop by design (Chris, 2026-07-10): the card is eyeballed
// first, then the click sends ONE ClickSend text acknowledging the issue.

const SMS_TEMPLATE = process.env.CONCERN_SMS_TEMPLATE ||
  'Hi {first_name}, thanks for raising this with us today — it’s been logged with our team and we’ll be in touch shortly. — Just Autos'

export async function approveConcernSms(concernId: string, by: string): Promise<string> {
  const c = sb()
  const { data: concern } = await c.from('call_concerns')
    .select('id, customer_name, customer_phone, sms_sent_at, sms_approved_by')
    .eq('id', concernId).maybeSingle()
  if (!concern) return '❌ Concern not found.'
  if (concern.sms_sent_at) return `Text already sent (approved by ${concern.sms_approved_by || 'someone'}) — not sending again.`
  if (!concern.customer_phone) return '❌ No customer number on this concern — text not sent.'

  const first = String(concern.customer_name || '').trim().split(/\s+/)[0] || 'there'
  const body = SMS_TEMPLATE.replace(/\{first_name\}/g, first[0] ? first[0].toUpperCase() + first.slice(1) : 'there')

  const { sendSms } = await import('./clicksend')
  const r = await sendSms(concern.customer_phone, body)
  if (!r.ok) {
    if (r.error === 'invalid_number') return `❌ ${concern.customer_phone} doesn't look like a textable AU mobile — no SMS sent.`
    return `❌ SMS failed: ${r.error}`
  }
  await c.from('call_concerns').update({
    sms_sent_at: new Date().toISOString(),
    sms_approved_by: by,
    sms_message_id: r.messageId || null,
  }).eq('id', concernId)
  return `📱 Text sent to ${concern.customer_name || concern.customer_phone} (approved by ${by}):\n>${body}`
}

// ── Slack button: Mark actioned ────────────────────────────────────────────

export async function markConcernActioned(concernId: string, by: string): Promise<string> {
  const c = sb()
  const { data: concern } = await c.from('call_concerns').select('id, slack_channel, slack_ts, followup_status').eq('id', concernId).maybeSingle()
  if (!concern) return '❌ Concern not found.'
  if (concern.followup_status === 'actioned') return 'Already marked actioned.'
  await c.from('call_concerns').update({
    followup_status: 'actioned',
    actioned_by: by,
    actioned_at: new Date().toISOString(),
  }).eq('id', concernId)
  return `✅ Marked actioned by ${by}.`
}

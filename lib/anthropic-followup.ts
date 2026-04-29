// lib/anthropic-followup.ts
// Generates structured follow-up summaries from call transcripts.
//
// TWO ENTRY POINTS:
//   - generateFollowUpSummary(transcript, ctx)        — one transcript, one summary.
//                                                       Used by the proactive sync cron
//                                                       and (legacy) Pipeline A read path.
//   - generateCombinedFollowUp(calls)                 — multiple calls for one customer,
//                                                       returns one cohesive narrative.
//                                                       Used by Pipeline B (Monday button).
//
// Designed for sales reps picking up a lead — answers "what was discussed,
// what did we promise, what comes next, and how do we close" — NOT coaching
// feedback on the rep's past behaviour (that's the separate coaching pipeline).
//
// Now also extracts email when the caller mentions one in the transcript,
// and produces 1-3 tactical closing tips for the next contact.
//
// Model: claude-haiku-4-5 by default. Override with FOLLOWUP_MODEL env var.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// ──────────────────────────────────────────────────────────────────────
// SINGLE-CALL TYPES + FUNCTIONS
// ──────────────────────────────────────────────────────────────────────

export interface FollowUpSummary {
  who_what: string
  discussed: string
  objections: string
  commitments: string
  closing_tips: string                 // 1-3 tactical tips, or 'None'
  next_step: string
  sentiment: 'hot' | 'warm' | 'cold'
  email: string | null
}

export interface FollowUpResult {
  summary: FollowUpSummary
  model: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
}

interface CallContext {
  direction: 'inbound' | 'outbound'
  agent_name: string | null
  caller_name: string | null
  external_number: string | null
  duration_seconds: number
  call_date: string
}

export async function generateFollowUpSummary(
  transcript: string,
  ctx: CallContext,
): Promise<FollowUpResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = process.env.FOLLOWUP_MODEL || DEFAULT_MODEL

  const systemPrompt = buildSingleSystemPrompt()
  const userPrompt = buildSingleUserPrompt(transcript, ctx)

  const body = {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Anthropic API ${r.status}: ${errText.substring(0, 500)}`)
  }

  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const summary = extractJson(text)
  validateSingleSummary(summary)

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { summary, model, inputTokens, outputTokens, costMicroUsd }
}

function buildSingleSystemPrompt(): string {
  return `You are summarising a phone call between a Just Autos sales rep and a customer (or prospect). Just Autos is an Australian automotive performance and tuning workshop, distributing tuning hardware to a network across Australia and running a workshop in QLD.

Your output is a FOLLOW-UP NOTE for the next sales rep who picks up this lead. It should answer: "What was discussed, what did we promise, what comes next, and how do we move this toward a close?" It is NOT a coaching summary or rep performance review — coaching is handled separately.

Output ONLY a JSON object with these exact fields:

{
  "who_what":     "1 sentence: the CUSTOMER's name (NOT the rep), vehicle (model + year if mentioned), and the core reason for the call. The Sales Rep field above tells you who the rep is — never identify them as the customer. If the customer's name isn't clear, use 'Unknown caller'. Example: 'Mark with a 2018 Ranger looking at a tune + DPF delete'.",
  "discussed":    "Key topics covered, in plain bullet-style prose (no bullet characters). Specific products, technical questions, pricing if discussed. 1-3 short sentences. Example: 'Asked about pricing on Stage 2 tune (~\\$2400 quoted), DPF delete legality in NSW, and turn-around time. Mentioned current setup is stock with 90,000km'.",
  "objections":   "Concerns or hesitations the customer raised. Just the objection itself, no analysis of how the rep handled it. If none, write exactly 'None'. Example: 'Worried about warranty implications and whether tune is reversible for resale'.",
  "commitments":  "Specific things the rep promised — quotes to send, callbacks, info to email, parts to check stock on. Include any mentioned timeframe. If none, write exactly 'None'. Example: 'Rep to email written quote by Friday; confirm stock on RV-30 turbo Monday'.",
  "closing_tips": "1-3 SPECIFIC, ACTIONABLE tips for what the next rep should do to move this customer toward a purchase, drawn from signals in THIS conversation. Each tip should be ONE short sentence and reference something concrete from the call (a product mentioned, an objection raised, a timeframe, a comparison made, the customer's role/use case). Format as a numbered list separated by newlines. If the call has no useful signals (voicemail, wrong number, hangup, pure information request with no buying intent), write exactly 'None'. Example: '1. Lead with the warranty answer — that was their main hesitation.\\n2. Send the written quote BEFORE calling — they asked for it twice and like seeing numbers.\\n3. Mention the workshop fits 4WDs all day — they were unsure if you handle dual-cab Rangers.'",
  "next_step":    "What the next contact should achieve. One sentence. Example: 'Follow up Friday afternoon to confirm quote received and book in for fitting'.",
  "sentiment":    "Exactly one of: 'hot' / 'warm' / 'cold'. HOT = ready to buy, has timeline, low objections. WARM = interested, info-gathering, may need follow-up. COLD = price-shopping only, low engagement, or has dealbreakers.",
  "email":        "The customer's email address if it appears in the transcript (e.g. when the customer or rep says 'I'll email you at sam@example.com', 'my email is...', 'send it to...'). Return the literal email string. If no email is mentioned, return null (the JSON null value, not the string 'null'). Do NOT make up an email."
}

GUIDANCE ON CLOSING TIPS:
- Tips should be TACTICAL and SPECIFIC to this conversation — not generic sales advice.
- Bad tip (generic): "Build rapport with the customer."
- Bad tip (generic): "Create urgency to close the deal."
- Bad tip (generic): "Be confident and ask for the sale."
- Good tip (specific): "Reference his comment about wanting it ready before his trip in March — anchor next call to that deadline."
- Good tip (specific): "Send the dyno comparison chart for the GU Patrol before calling — he asked for hard numbers twice."
- Good tip (specific): "Don't lead with price — he flinched at the \\$3k figure. Instead, lead with what's INCLUDED for that price."
- Good tip (specific): "He mentioned his mate has a tuned 79 series — invite him to ask the mate, then call back. Social proof is the lever here."
- Tips can address: how to handle a stated objection, what to send before the next call, what to lead with, what NOT to mention, an angle/use-case to emphasise, a third-party reference to leverage, a competitor offer to counter.
- Don't critique the rep's performance ("the rep should have asked X earlier") — that's coaching feedback, not a closing tip.
- If the call had no real conversation (voicemail, wrong number), tips = 'None'.

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Use plain text inside the JSON values — no bullet characters, no asterisks, no special formatting EXCEPT closing_tips uses '1.', '2.', '3.' and \\n newlines as shown.
- Be specific about products, vehicle details, and dollar amounts when mentioned.
- Don't invent details. If the transcript doesn't mention something, don't speculate.
- The "Sales Rep" field in the user prompt is the AGENT, never the customer. who_what must always describe the customer.
- If the call was clearly wrong-number, voicemail, or under 30 seconds of substance, set sentiment to 'cold', use 'No substantive conversation' for who_what, and 'None' for closing_tips.
- For email: only return values that look like real email addresses (have @ and a domain). If unsure, return null.`
}

function buildSingleUserPrompt(transcript: string, ctx: CallContext): string {
  const lines: string[] = []
  lines.push(`Call direction: ${ctx.direction}`)
  if (ctx.agent_name) lines.push(`Sales rep (NOT the customer): ${ctx.agent_name}`)
  if (ctx.caller_name) lines.push(`Caller name (from CDR): ${ctx.caller_name}`)
  if (ctx.external_number) lines.push(`Caller number: ${ctx.external_number}`)
  lines.push(`Duration: ${Math.round(ctx.duration_seconds)}s`)
  lines.push(`Date: ${ctx.call_date}`)
  lines.push('')
  lines.push('--- TRANSCRIPT ---')
  lines.push(transcript)
  lines.push('--- END TRANSCRIPT ---')
  lines.push('')
  lines.push('Produce the JSON follow-up note. Remember: who_what must describe the CUSTOMER, not the rep. Closing tips must be specific to this conversation.')
  return lines.join('\n')
}

function validateSingleSummary(s: any): asserts s is FollowUpSummary {
  const requiredStrings = ['who_what', 'discussed', 'objections', 'commitments', 'closing_tips', 'next_step', 'sentiment']
  for (const key of requiredStrings) {
    if (typeof s[key] !== 'string' || !s[key].trim()) {
      throw new Error(`Follow-up summary missing or empty field: ${key}`)
    }
  }
  if (!['hot', 'warm', 'cold'].includes(s.sentiment)) {
    throw new Error(`Invalid sentiment '${s.sentiment}' — must be hot/warm/cold`)
  }
  s.email = sanitiseEmail(s.email)
}

export function renderSummaryAsNote(
  s: FollowUpSummary,
  ctx: { agentName?: string; callDate?: string; durationSec?: number },
): string {
  const header = ctx.callDate
    ? `📞 Call ${new Date(ctx.callDate).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })}${ctx.agentName ? ` · ${ctx.agentName}` : ''}${ctx.durationSec ? ` · ${Math.round(ctx.durationSec / 60)}m${ctx.durationSec % 60}s` : ''}`
    : '📞 Call follow-up'

  const sentimentBadge =
    s.sentiment === 'hot' ? '🔥 HOT'
    : s.sentiment === 'warm' ? '☀️ WARM'
    : '🧊 COLD'

  const lines: string[] = [header, sentimentBadge, '', `Who: ${s.who_what}`, '', `Discussed: ${s.discussed}`]
  if (s.objections && s.objections.toLowerCase() !== 'none') lines.push('', `Objections: ${s.objections}`)
  if (s.commitments && s.commitments.toLowerCase() !== 'none') lines.push('', `Promised: ${s.commitments}`)
  if (s.closing_tips && s.closing_tips.toLowerCase() !== 'none') lines.push('', `💡 Closing tips:`, s.closing_tips)
  lines.push('', `Next step: ${s.next_step}`)
  return lines.join('\n')
}


// ──────────────────────────────────────────────────────────────────────
// COMBINED MULTI-CALL TYPES + FUNCTIONS (Pipeline B)
// ──────────────────────────────────────────────────────────────────────

export interface CombinedCallInput {
  callId: string
  callDate: string                  // ISO timestamp
  direction: 'inbound' | 'outbound'
  agentName: string | null
  durationSeconds: number
  transcript: string
}

export interface CombinedFollowUp {
  who_what: string                  // who + what they're trying to do, OVERALL
  what_happened: string             // narrative across calls
  outstanding: string               // unresolved items (or 'None')
  closing_tips: string              // 1-3 tactical tips drawn from the full history (or 'None')
  next_step: string                 // single recommended next action
  sentiment: 'hot' | 'warm' | 'cold'
  email: string | null
}

export interface CombinedFollowUpResult {
  summary: CombinedFollowUp
  model: string
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  calls: CombinedCallInput[]
}

export async function generateCombinedFollowUp(
  calls: CombinedCallInput[],
): Promise<CombinedFollowUpResult> {
  if (calls.length === 0) throw new Error('generateCombinedFollowUp called with no calls')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = process.env.FOLLOWUP_MODEL || DEFAULT_MODEL

  const ordered = [...calls].sort(
    (a, b) => new Date(a.callDate).getTime() - new Date(b.callDate).getTime(),
  )

  const systemPrompt = buildCombinedSystemPrompt()
  const userPrompt = buildCombinedUserPrompt(ordered)

  const body = {
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }

  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errText = await r.text()
    throw new Error(`Anthropic API ${r.status}: ${errText.substring(0, 500)}`)
  }

  const data = await r.json()
  const text = data.content?.[0]?.text || ''
  const summary = extractJson(text)
  validateCombinedSummary(summary)

  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { summary, model, inputTokens, outputTokens, costMicroUsd, calls: ordered }
}

function buildCombinedSystemPrompt(): string {
  return `You are summarising the recent phone-call history for ONE customer of Just Autos. Just Autos is an Australian automotive performance and tuning workshop, distributing tuning hardware to a network across Australia and running a workshop in QLD.

You will be given multiple call transcripts in chronological order (oldest first). They are all between this customer and Just Autos sales reps (the rep may differ between calls).

Your output is a SINGLE COHESIVE FOLLOW-UP NOTE for the next rep picking up this lead. It should answer: "Where is this customer at right now, what comes next, and how do we close?" It is NOT a coaching summary or rep performance review.

Output ONLY a JSON object with these exact fields:

{
  "who_what":      "1-2 sentences: who the CUSTOMER is (NAME — never the rep), their vehicle if known, and what they're ultimately trying to achieve across these calls. Example: 'Jason — interested in a Land Cruiser 200 build. Multiple touchpoints, mostly missed connections.'",
  "what_happened": "A narrative across the calls: what's actually been discussed, what's progressed, what hasn't. Reference specific calls when useful (e.g. 'On the first call...', 'On the most recent call...'). 2-4 sentences. Don't list every call mechanically — synthesise the story.",
  "outstanding":   "What's STILL unresolved or owed to the customer right now. Quotes promised but not sent, callbacks owed, decisions pending. If everything has been actioned and nothing's outstanding, write exactly 'None'.",
  "closing_tips":  "1-3 SPECIFIC, ACTIONABLE tips drawn from PATTERNS across the call history — what to do differently or emphasise on the next contact to move this customer toward a purchase. Each tip should be ONE short sentence and reference something concrete from the calls. Format as a numbered list separated by newlines. If there's no useful signal (all voicemails, no real conversation), write exactly 'None'. Example: '1. Three voicemails in a row — try SMS instead of calling.\\n2. He's mentioned price twice but never the spec — lead with what makes the Stage 3 different from Stage 2.\\n3. His timeline keeps slipping (\"next week\" said three times) — get a deposit to anchor commitment.'",
  "next_step":     "ONE concrete recommended next action for the rep. Example: 'Try Jason again, possibly by SMS — two voice attempts have failed.'",
  "sentiment":     "Exactly one of: 'hot' / 'warm' / 'cold'. This is the OVERALL sentiment based on where the customer is RIGHT NOW, not any single call. HOT = engaged, has timeline, ready to commit. WARM = interested, ongoing dialogue, needs nurturing. COLD = price-shopping, unreachable, or has dealbreakers.",
  "email":         "The customer's email address if it appears in any of the transcripts. Return the literal email string. If no email is mentioned, return null (the JSON null, not the string 'null'). Do NOT make up an email."
}

GUIDANCE ON CLOSING TIPS:
- Tips should be TACTICAL and SPECIFIC, drawn from PATTERNS across the call history — not generic sales advice.
- The advantage of multi-call view: you can spot trends a single-call summary misses (repeated objections, shifting timelines, communication preferences).
- Bad tip (generic): "Build rapport with the customer."
- Bad tip (generic): "Create urgency."
- Good tip (specific, multi-call): "He's only ever picked up calls after 4pm — stop calling mornings."
- Good tip (specific, multi-call): "Same objection (warranty) raised on calls 1 and 3 — the warranty answer either isn't landing or wasn't fully addressed. Try a different angle, e.g. example customers."
- Good tip (specific, multi-call): "Quote was sent but never confirmed received — open with 'did the quote come through ok?' before pitching anything new."
- Good tip (specific, multi-call): "Mentioned his Patrol on the first call, his Hilux on the second — confirm which vehicle this quote is actually for before progressing."
- Tips can address: communication channel preference, timing patterns, recurring objections, missed commitments, ambiguity that needs resolving, leverage points the rep hasn't pulled yet.
- Don't critique any rep's past performance — coaching is separate.
- If all calls are voicemails / no real conversation, tips = 'None'.

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Plain text in JSON values — no bullets, no asterisks, no special formatting EXCEPT closing_tips uses '1.', '2.', '3.' and \\n newlines as shown.
- The "Rep" labelled in each call header is a Just Autos employee, NEVER the customer. who_what must describe the customer.
- Don't invent details. If a transcript is short or missed (voicemail, hangup), reflect that honestly.
- "what_happened" should give the rep enough context to walk into the next call confidently. Be specific about products, prices, dates, vehicles, and decisions.
- "sentiment" is overall and present-tense — judge from how things stand NOW, not the average across history.
- For email: only return strings that look like real emails (have @ and a domain). If unsure, return null.`
}

function buildCombinedUserPrompt(calls: CombinedCallInput[]): string {
  const lines: string[] = []
  lines.push(`Customer call history — ${calls.length} call(s) in chronological order (oldest first):`)
  lines.push('')

  calls.forEach((c, i) => {
    const dateStr = new Date(c.callDate).toLocaleString('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Australia/Brisbane',
    })
    lines.push(`──────── Call ${i + 1} of ${calls.length} ────────`)
    lines.push(`Date: ${dateStr}`)
    lines.push(`Direction: ${c.direction}`)
    lines.push(`Rep (NOT the customer): ${c.agentName || 'unknown'}`)
    lines.push(`Duration: ${c.durationSeconds}s`)
    lines.push('Transcript:')
    lines.push(c.transcript)
    lines.push('')
  })

  lines.push('────────')
  lines.push('Produce the JSON combined follow-up note. Remember: who_what describes the CUSTOMER, sentiment is overall and present-tense, closing tips draw from patterns across calls.')
  return lines.join('\n')
}

function validateCombinedSummary(s: any): asserts s is CombinedFollowUp {
  const requiredStrings = ['who_what', 'what_happened', 'outstanding', 'closing_tips', 'next_step', 'sentiment']
  for (const key of requiredStrings) {
    if (typeof s[key] !== 'string' || !s[key].trim()) {
      throw new Error(`Combined follow-up missing or empty field: ${key}`)
    }
  }
  if (!['hot', 'warm', 'cold'].includes(s.sentiment)) {
    throw new Error(`Invalid sentiment '${s.sentiment}' — must be hot/warm/cold`)
  }
  s.email = sanitiseEmail(s.email)
}

export function renderCombinedNote(
  s: CombinedFollowUp,
  ctx: {
    calls: Array<{
      callDate: string
      agentName: string | null
      direction: 'inbound' | 'outbound'
      durationSeconds: number
    }>
  },
): string {
  const total = ctx.calls.length

  const mostRecent = ctx.calls.reduce(
    (max, c) => new Date(c.callDate) > new Date(max.callDate) ? c : max,
    ctx.calls[0],
  )
  const latestStr = new Date(mostRecent.callDate).toLocaleString('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Brisbane',
  })

  const sentimentBadge =
    s.sentiment === 'hot' ? '🔥 HOT'
    : s.sentiment === 'warm' ? '☀️ WARM'
    : '🧊 COLD'

  const callWord = total === 1 ? 'call' : 'calls'
  const header = `📞 Customer history — ${total} ${callWord} in last 30 days · Latest: ${latestStr}`

  const lines: string[] = [
    header,
    sentimentBadge,
    '',
    `Who: ${s.who_what}`,
    '',
    `What's happened: ${s.what_happened}`,
  ]

  if (s.outstanding && s.outstanding.toLowerCase() !== 'none') {
    lines.push('', `Outstanding: ${s.outstanding}`)
  }

  if (s.closing_tips && s.closing_tips.toLowerCase() !== 'none') {
    lines.push('', `💡 Closing tips:`, s.closing_tips)
  }

  lines.push('', `Next step: ${s.next_step}`)

  const callsAsc = [...ctx.calls].sort(
    (a, b) => new Date(a.callDate).getTime() - new Date(b.callDate).getTime(),
  )
  lines.push('', 'Calls referenced:')
  for (const c of callsAsc) {
    const d = new Date(c.callDate).toLocaleString('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Australia/Brisbane',
    })
    const mins = Math.floor(c.durationSeconds / 60)
    const secs = c.durationSeconds % 60
    const dur = `${mins}m${secs.toString().padStart(2, '0')}s`
    const rep = c.agentName ? ` · ${c.agentName}` : ''
    lines.push(`  • ${d}${rep} · ${dur} · ${c.direction}`)
  }

  return lines.join('\n')
}


// ──────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ──────────────────────────────────────────────────────────────────────

function extractJson(text: string): any {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.substring(first, last + 1))
    }
    throw new Error(`Could not parse JSON from model output: ${cleaned.substring(0, 200)}`)
  }
}

function sanitiseEmail(raw: any): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || !trimmed.includes('@') || !trimmed.includes('.')) return null
  return trimmed.toLowerCase()
}

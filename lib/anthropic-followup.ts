// lib/anthropic-followup.ts
// Generates a structured 7-field follow-up summary from a call transcript.
// Designed for sales reps picking up a lead cold — answers "what was discussed,
// what did we promise, what comes next" — NOT coaching feedback.
//
// Now also extracts email when the caller mentions one in the transcript
// (e.g. "I'll email you at sam@example.com" or "send the quote to..."). This
// is used downstream to search AC by email when phone match fails.
//
// Runs independently of the existing coaching pipeline. The coaching pipeline
// produces call_analysis.summary (coaching-flavoured); this one populates
// call_analysis.follow_up_summary (lead-context-flavoured).
//
// Model: matches what the existing coaching pipeline uses (claude-haiku-4-5),
// since this is a simpler summarisation task that doesn't need Opus-level
// reasoning. Keep the model env-overridable in case we want to swap later.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'  // matches active coaching model

export interface FollowUpSummary {
  who_what: string       // caller, vehicle/product, brief context
  discussed: string      // key topics, products, technical questions
  objections: string     // concerns raised — or "none" if none
  commitments: string    // what we promised, by when — or "none"
  next_step: string      // what should happen on the next contact
  sentiment: 'hot' | 'warm' | 'cold'  // urgency for the next person picking it up
  email: string | null   // customer's email if mentioned in transcript, else null
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

/**
 * Generate a follow-up summary from a transcript.
 *
 * @param transcript Full plaintext transcript (from call_transcripts.full_text)
 * @param ctx        Metadata about the call (direction, agent, customer info)
 * @returns          Structured 7-field summary + token/cost telemetry
 */
export async function generateFollowUpSummary(
  transcript: string,
  ctx: CallContext,
): Promise<FollowUpResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const model = process.env.FOLLOWUP_MODEL || DEFAULT_MODEL

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(transcript, ctx)

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

  // Validate shape — Claude can occasionally return malformed JSON or miss fields.
  // Fail loudly so the worker retries rather than persisting garbage.
  validateSummary(summary)

  // Cost calc — Haiku 4.5 pricing: $1/MTok input, $5/MTok output (as of Apr 2026).
  // Override per-model with FOLLOWUP_COST_INPUT_MICRO / FOLLOWUP_COST_OUTPUT_MICRO
  // env vars if pricing changes.
  const inputTokens = data.usage?.input_tokens ?? 0
  const outputTokens = data.usage?.output_tokens ?? 0
  const inputCostPerMTok = Number(process.env.FOLLOWUP_COST_INPUT_MICRO || 1_000_000)   // micro USD per MTok
  const outputCostPerMTok = Number(process.env.FOLLOWUP_COST_OUTPUT_MICRO || 5_000_000)
  const costMicroUsd =
    Math.round((inputTokens / 1_000_000) * inputCostPerMTok) +
    Math.round((outputTokens / 1_000_000) * outputCostPerMTok)

  return { summary, model, inputTokens, outputTokens, costMicroUsd }
}

// ── Prompt construction ──────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are summarising a phone call between a Just Autos sales rep and a customer (or prospect). Just Autos is an Australian automotive performance and tuning workshop, distributing tuning hardware to a network across Australia and running a workshop in QLD.

Your output is a FOLLOW-UP NOTE for the next sales rep who picks up this lead. It should answer: "What was discussed, what did we promise, what comes next?" It is NOT a coaching summary or rep performance review — coaching is handled separately.

Output ONLY a JSON object with these exact fields:

{
  "who_what":    "1 sentence: the CUSTOMER's name (NOT the rep), vehicle (model + year if mentioned), and the core reason for the call. The Sales Rep field above tells you who the rep is — never identify them as the customer. If the customer's name isn't clear, use 'Unknown caller'. Example: 'Mark with a 2018 Ranger looking at a tune + DPF delete'.",
  "discussed":   "Key topics covered, in plain bullet-style prose (no bullet characters). Specific products, technical questions, pricing if discussed. 1-3 short sentences. Example: 'Asked about pricing on Stage 2 tune (~\\$2400 quoted), DPF delete legality in NSW, and turn-around time. Mentioned current setup is stock with 90,000km'.",
  "objections":  "Concerns or hesitations the customer raised. Just the objection itself, no analysis of how the rep handled it. If none, write exactly 'None'. Example: 'Worried about warranty implications and whether tune is reversible for resale'.",
  "commitments": "Specific things the rep promised — quotes to send, callbacks, info to email, parts to check stock on. Include any mentioned timeframe. If none, write exactly 'None'. Example: 'Rep to email written quote by Friday; confirm stock on RV-30 turbo Monday'.",
  "next_step":   "What the next contact should achieve. One sentence. Example: 'Follow up Friday afternoon to confirm quote received and book in for fitting'.",
  "sentiment":   "Exactly one of: 'hot' / 'warm' / 'cold'. HOT = ready to buy, has timeline, low objections. WARM = interested, info-gathering, may need follow-up. COLD = price-shopping only, low engagement, or has dealbreakers.",
  "email":       "The customer's email address if it appears in the transcript (e.g. when the customer or rep says 'I'll email you at sam@example.com', 'my email is...', 'send it to...'). Return the literal email string. If no email is mentioned, return null (the JSON null value, not the string 'null'). Do NOT make up an email."
}

Rules:
- Output ONLY the JSON. No preamble, no markdown fences, no commentary.
- Use plain text inside the JSON values — no bullet characters, no asterisks, no special formatting.
- Be specific about products, vehicle details, and dollar amounts when mentioned.
- Don't invent details. If the transcript doesn't mention something, don't speculate.
- The "Sales Rep" field in the user prompt is the AGENT, never the customer. who_what must always describe the customer.
- If the call was clearly wrong-number, voicemail, or under 30 seconds of substance, set sentiment to 'cold' and use 'No substantive conversation' for who_what.
- For email: only return values that look like real email addresses (have @ and a domain). If unsure, return null.`
}

function buildUserPrompt(transcript: string, ctx: CallContext): string {
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
  lines.push('Produce the JSON follow-up note. Remember: who_what must describe the CUSTOMER, not the rep.')
  return lines.join('\n')
}

// ── Output parsing & validation ──────────────────────────────────────────

function extractJson(text: string): any {
  // Claude occasionally wraps JSON in ```json fences despite instructions.
  // Strip them and any leading/trailing whitespace before parsing.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // Last-ditch: find the first { and last } and parse the slice.
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.substring(first, last + 1))
    }
    throw new Error(`Could not parse JSON from model output: ${cleaned.substring(0, 200)}`)
  }
}

function validateSummary(s: any): asserts s is FollowUpSummary {
  const requiredStrings = ['who_what', 'discussed', 'objections', 'commitments', 'next_step', 'sentiment']
  for (const key of requiredStrings) {
    if (typeof s[key] !== 'string' || !s[key].trim()) {
      throw new Error(`Follow-up summary missing or empty field: ${key}`)
    }
  }
  if (!['hot', 'warm', 'cold'].includes(s.sentiment)) {
    throw new Error(`Invalid sentiment '${s.sentiment}' — must be hot/warm/cold`)
  }
  // Email is allowed to be null OR a string. Coerce empty strings → null.
  if (s.email !== null && s.email !== undefined) {
    if (typeof s.email !== 'string') {
      s.email = null
    } else {
      const trimmed = s.email.trim()
      // Basic sanity: contains @ and a dot. Rejects common Claude hallucinations.
      if (!trimmed || !trimmed.includes('@') || !trimmed.includes('.')) {
        s.email = null
      } else {
        s.email = trimmed.toLowerCase()
      }
    }
  } else {
    s.email = null
  }
}

// ── Render summary as plain-text note for AC / Monday ────────────────────

/**
 * Render a follow-up summary as a human-readable note suitable for posting
 * to a Monday update or AC contact note. Designed to scan quickly on mobile.
 */
export function renderSummaryAsNote(s: FollowUpSummary, ctx: { agentName?: string; callDate?: string; durationSec?: number }): string {
  const header = ctx.callDate
    ? `📞 Call ${new Date(ctx.callDate).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Australia/Brisbane' })}${ctx.agentName ? ` · ${ctx.agentName}` : ''}${ctx.durationSec ? ` · ${Math.round(ctx.durationSec / 60)}m${ctx.durationSec % 60}s` : ''}`
    : '📞 Call follow-up'

  const sentimentBadge = s.sentiment === 'hot' ? '🔥 HOT'
    : s.sentiment === 'warm' ? '☀️ WARM'
    : '🧊 COLD'

  const lines: string[] = [
    header,
    `${sentimentBadge}`,
    '',
    `Who: ${s.who_what}`,
    '',
    `Discussed: ${s.discussed}`,
  ]
  if (s.objections && s.objections.toLowerCase() !== 'none') {
    lines.push('', `Objections: ${s.objections}`)
  }
  if (s.commitments && s.commitments.toLowerCase() !== 'none') {
    lines.push('', `Promised: ${s.commitments}`)
  }
  lines.push('', `Next step: ${s.next_step}`)
  return lines.join('\n')
}

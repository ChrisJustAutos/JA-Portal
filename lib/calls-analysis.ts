// lib/calls-analysis.ts
//
// Portal-side call coaching analysis — replaces the FreePBX worker's analysis
// loop (the worker keeps CDR sync + transcription). Differences from the
// worker version:
//
//   • CALL-TYPE AWARE: when the rubric defines `call_types`, the model first
//     classifies the conversation type (new sales enquiry, quote follow-up,
//     booking/scheduling, status/support, not coachable) and then scores
//     against THAT type's dimension set. Non-coachable calls (suppliers,
//     personal, wrong numbers) are classified but never scored.
//   • TRANSCRIPT-BASED ADVISOR ID: extensions are hot-desked, so the agent's
//     self-introduction on the call is the source of truth. A confident
//     identification is written back to calls.effective_advisor_* via the
//     call_advisor_roster (name/alias → slack id), overriding the extension
//     guess.
//
// Gated by CALLS_ANALYSIS_ENABLED (default OFF) so the cron no-ops until the
// worker's analysis loop is disabled — both writing call_analysis at once
// would double-spend and race. Dry runs work while disabled.
//
// Writes: call_analysis (insert; latest row wins in the UI) + the denormalised
// coaching columns on calls (sales_score, outcome_classification,
// coaching_summary, objections_raised, analysed_at) that reports + the MCP
// tool read. Completes matching analysis_jobs rows so the /calls panel stops
// showing "pending".

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { postMessage } from './slack-bot/slack'
import { callTypeLabel } from './calls-dimensions'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = process.env.CALLS_ANALYSIS_MODEL || 'claude-sonnet-4-6'
const MIN_SECONDS = 60

// $/MTok in micro-USD (Sonnet pricing defaults; override per env if the model changes)
const COST_INPUT_MICRO  = Number(process.env.CALLS_ANALYSIS_COST_INPUT_MICRO  || 3_000_000)
const COST_OUTPUT_MICRO = Number(process.env.CALLS_ANALYSIS_COST_OUTPUT_MICRO || 15_000_000)

export const callsAnalysisEnabled = () =>
  (process.env.CALLS_ANALYSIS_ENABLED || 'false').toLowerCase().trim() === 'true'

// #sales-coaching — same channel the worker's "JA Coach Bot" posted to.
// Set to '' to disable the per-call Slack ticker.
const coachingChannel = () => (process.env.CALLS_COACHING_SLACK_CHANNEL ?? 'C0AU8QWT7QF').trim()

let _sb: SupabaseClient | null = null
function sb(): SupabaseClient {
  if (_sb) return _sb
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase env vars missing')
  _sb = createClient(url, key, { auth: { persistSession: false } })
  return _sb
}

// ── Types ────────────────────────────────────────────────────────────────

export interface RubricCallType {
  id: string
  label: string
  description: string          // classification guidance shown to the model
  scoreable: boolean
  dimensions?: { id: string; label: string; weight: number; description: string; anchors?: string }[]
}

interface RubricRow {
  version: string
  prompt_template: string
  company_context: string | null
  dimensions: any
  call_types: RubricCallType[] | null
}

const OUTCOMES = ['sale', 'quote_given', 'callback_scheduled', 'information_only', 'no_outcome', 'wrong_number', 'other']

export interface AnalyseResult {
  callId: string
  ok: boolean
  skipped?: string             // reason when not analysed (no transcript / too short)
  error?: string
  callType?: string | null
  outcome?: string
  salesScore?: number | null
  advisor?: { identified: string | null; confidence: string | null; applied: boolean; reason?: string }
  costMicroUsd?: number
  analysisId?: string
  slacked?: boolean            // coaching line posted to #sales-coaching
  // dry-run payload
  parsed?: any
}

// ── Rubric ───────────────────────────────────────────────────────────────

export async function getRubric(version?: string | null): Promise<RubricRow> {
  const c = sb()
  let q = c.from('coaching_rubrics').select('version, prompt_template, company_context, dimensions, call_types')
  const { data, error } = version
    ? await q.eq('version', version).maybeSingle()
    : await q.eq('is_active', true).maybeSingle()
  if (error) throw new Error(`rubric load failed: ${error.message}`)
  if (!data) throw new Error(version ? `rubric "${version}" not found` : 'no active coaching rubric')
  return data as RubricRow
}

// Render the {call_types} placeholder from the rubric's jsonb so editing the
// DB row changes the prompt without a deploy.
function renderCallTypes(types: RubricCallType[]): string {
  const parts: string[] = []
  for (const t of types) {
    parts.push(`### ${t.id} — ${t.label}${t.scoreable ? '' : '  (NOT SCORED)'}`)
    parts.push(t.description)
    if (t.scoreable && t.dimensions?.length) {
      parts.push(`Dimensions (score each 0-10; weights shown compute sales_score):`)
      for (const d of t.dimensions) {
        parts.push(`- ${d.id} (weight ${d.weight}) — ${d.label}: ${d.description}${d.anchors ? `\n  Anchors: ${d.anchors}` : ''}`)
      }
    }
    parts.push('')
  }
  return parts.join('\n')
}

// ── Transcript formatting ────────────────────────────────────────────────
// Deepgram segments carry integer speaker ids. Historically the UI assumed
// "speaker 0 = agent"; we hand the model neutral labels plus the heuristic and
// let it decide from content (greeting, roster names, who answers questions).
function formatTranscript(segments: any, fullText: string | null): string {
  if (Array.isArray(segments) && segments.length > 0) {
    const lines: string[] = []
    for (const s of segments) {
      const sp = s.speaker ?? s.speaker_id ?? '?'
      const text = (s.text || s.transcript || '').trim()
      if (text) lines.push(`S${sp}: ${text}`)
    }
    if (lines.length) return lines.join('\n')
  }
  return fullText || ''
}

// ── Claude call ──────────────────────────────────────────────────────────

function extractJson(text: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1))
  throw new Error('no JSON object in model output')
}

async function callClaude(prompt: string): Promise<{ parsed: any; model: string; inputTokens: number; outputTokens: number; costMicroUsd: number; raw: any }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const model = DEFAULT_MODEL
  const r = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!r.ok) {
    const body = await r.text()
    throw new Error(`Anthropic API ${r.status}: ${body.slice(0, 300)}`)
  }
  const data = await r.json()
  const text = data.content?.[0]?.text
  if (!text) throw new Error('empty model response')
  const parsed = extractJson(text)
  const inputTokens = data.usage?.input_tokens || 0
  const outputTokens = data.usage?.output_tokens || 0
  const costMicroUsd = Math.round((inputTokens / 1_000_000) * COST_INPUT_MICRO + (outputTokens / 1_000_000) * COST_OUTPUT_MICRO)
  return { parsed, model, inputTokens, outputTokens, costMicroUsd, raw: data }
}

// ── Validation ───────────────────────────────────────────────────────────

function validateParsed(parsed: any, rubric: RubricRow): { callType: RubricCallType | null; salesScore: number | null } {
  if (!parsed || typeof parsed !== 'object') throw new Error('model output is not an object')
  if (!OUTCOMES.includes(parsed.outcome)) throw new Error(`invalid outcome "${parsed.outcome}"`)

  let callType: RubricCallType | null = null
  if (rubric.call_types?.length) {
    callType = rubric.call_types.find(t => t.id === parsed.call_type) || null
    if (!callType) throw new Error(`invalid call_type "${parsed.call_type}"`)
  }

  // Non-scoreable (or legacy gated) calls carry null scores — fine.
  if (parsed.dimension_scores == null || parsed.sales_score == null) {
    return { callType, salesScore: null }
  }

  const dims: { id: string; weight: number }[] = callType?.dimensions?.length
    ? callType.dimensions
    : (Array.isArray(rubric.dimensions) ? rubric.dimensions : [])
  let computed = 0
  for (const d of dims) {
    const v = parsed.dimension_scores[d.id]
    if (typeof v !== 'number' || v < 0 || v > 10) throw new Error(`dimension "${d.id}" missing or out of range`)
    computed += v * d.weight
  }
  // Recompute the headline from the weights — the model occasionally slips on
  // arithmetic and the weighted sum is the contract.
  const salesScore = Math.max(0, Math.min(100, Math.round(computed)))
  return { callType, salesScore }
}

// ── Advisor identification → calls.effective_advisor_* ──────────────────

interface RosterRow { name: string; aliases: string[]; slack_user_id: string | null; extensions: string[]; active: boolean }

async function getRoster(c: SupabaseClient): Promise<RosterRow[]> {
  const { data } = await c.from('call_advisor_roster').select('name, aliases, slack_user_id, extensions, active').eq('active', true)
  return (data as RosterRow[]) || []
}

// Levenshtein distance — transcription mangles names ("Dom" → "Don",
// "Kaleb" → "Caleb"), so an unambiguous one-edit match still counts.
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 2) return 99
  const row = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[n]
}

function matchRoster(roster: RosterRow[], name: string | null | undefined): RosterRow | null {
  if (!name) return null
  const n = String(name).trim().toLowerCase()
  if (!n) return null
  // Exact name or alias first.
  const exact = roster.find(r =>
    r.name.toLowerCase() === n || (r.aliases || []).some(a => a.toLowerCase() === n),
  )
  if (exact) return exact
  // Fuzzy: within one edit of exactly ONE roster name/alias (≥3 chars, so
  // "Don"→Dom matches but short noise can't). Ambiguity → no match.
  if (n.length < 3) return null
  const fuzzy = roster.filter(r =>
    [r.name, ...(r.aliases || [])].some(c => c.length >= 3 && editDistance(c.toLowerCase(), n) <= 1),
  )
  return fuzzy.length === 1 ? fuzzy[0] : null
}

// Confidence policy: 'high' (explicit self-introduction) always wins — the
// transcript beats any extension guess, including the worker's 'identified'.
// 'medium' only fills gaps (null / ext-default), never overrides a positive id.
async function applyAdvisor(
  c: SupabaseClient,
  call: { id: string; effective_advisor_source: string | null; effective_advisor_slack_user_id: string | null },
  roster: RosterRow[],
  identifiedName: string | null,
  confidence: string | null,
): Promise<{ identified: string | null; confidence: string | null; applied: boolean; reason?: string }> {
  const out = { identified: identifiedName ?? null, confidence: confidence ?? null, applied: false as boolean, reason: undefined as string | undefined }
  const match = matchRoster(roster, identifiedName)
  if (!match || !match.slack_user_id) { out.reason = identifiedName ? 'name not on roster' : 'not identified'; return out }
  if (confidence !== 'high' && confidence !== 'medium') { out.reason = `confidence ${confidence || 'none'}`; return out }
  if (call.effective_advisor_slack_user_id === match.slack_user_id) { out.reason = 'already attributed'; return out }
  const positivelyAttributed = call.effective_advisor_source === 'identified' || call.effective_advisor_source === 'transcript'
  if (confidence === 'medium' && positivelyAttributed) { out.reason = 'medium confidence won\'t override a positive id'; return out }

  const { error } = await c.from('calls').update({
    effective_advisor_name: match.name,
    effective_advisor_slack_user_id: match.slack_user_id,
    effective_advisor_source: 'transcript',
  }).eq('id', call.id)
  if (error) { out.reason = `update failed: ${error.message}`; return out }
  out.applied = true
  return out
}

// ── Slack coaching card (#sales-coaching) ────────────────────────────────
// Full card per analysed call, matching the worker's JA Coach Bot format plus
// the call type: advisor @-mention, score, outcome/type/direction/duration,
// summary, dimension bars, strengths & improvements, and a portal link.
// Unscored calls get a one-liner. Best-effort — a Slack failure never fails
// the analysis.

const OUTCOME_LABELS: Record<string, string> = {
  sale: 'Sale', quote_given: 'Quote given', callback_scheduled: 'Callback scheduled',
  information_only: 'Information only', no_outcome: 'No outcome', wrong_number: 'Wrong number', other: 'Other',
}

function scoreEmoji(score: number): string {
  if (score >= 80) return ':large_green_circle:'
  if (score >= 60) return ':large_yellow_circle:'
  if (score >= 40) return ':large_orange_circle:'
  return ':red_circle:'
}

// 5-square bar, coloured by the score band (matches the old bot's look).
function dimBar(v: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(v / 2)))
  const sq = v >= 7 ? ':large_green_square:' : v >= 4 ? ':large_yellow_square:' : ':large_red_square:'
  return sq.repeat(filled) + ':white_large_square:'.repeat(5 - filled)
}

// Resolve any raw name (transcript OR extension tag — tags can be full names
// like "Tyronne Wright" / "Dom S") to a roster member: full string first,
// then the first token.
function resolveAnyName(roster: RosterRow[], raw: string | null | undefined): RosterRow | null {
  if (!raw) return null
  return matchRoster(roster, raw) || matchRoster(roster, String(raw).trim().split(/\s+/)[0])
}

async function postCoachingSlack(args: {
  call: any
  outcome: string
  callTypeId: string | null
  salesScore: number | null
  summary: string | null
  identifiedName: string | null
  roster: RosterRow[]
  dimensionScores: Record<string, number> | null
  dimensionLabels: Record<string, string>
  observations: any
  rubricVersion: string
  costMicroUsd: number
}): Promise<boolean> {
  const channel = coachingChannel()
  if (!channel) return false
  const { call, outcome, callTypeId, salesScore, summary, identifiedName, roster, dimensionScores, dimensionLabels, observations, rubricVersion, costMicroUsd } = args

  const outcomeText = OUTCOME_LABELS[outcome] || outcome
  const typeText = callTypeId ? ` · ${callTypeLabel(callTypeId)}` : ''
  const number = call.external_number || 'unknown number'
  const seconds = call.billsec_seconds || call.duration_seconds || 0
  const duration = `${Math.floor(seconds / 60)}m ${seconds % 60}s`

  if (salesScore == null) {
    const emoji = outcome === 'wrong_number' ? ':x:' : outcome === 'callback_scheduled' ? ':date:' : ':information_source:'
    const text = `${emoji} ${outcomeText}${typeText} — ${number} (${duration}) — not scored`
    try { return !!(await postMessage({ channel, text })) }
    catch (e: any) { console.error('[calls-analysis] slack post failed:', e?.message || e); return false }
  }

  // Advisor line. A mismatch is only real when the transcript name and the
  // extension tag resolve to DIFFERENT roster members — tags carry full names
  // ("Tyronne Wright") which must not warn against "Tyronne".
  const idMatch = resolveAnyName(roster, identifiedName)
  const tagMatch = resolveAnyName(roster, call.agent_name)
  const mismatch = !!(idMatch && tagMatch && idMatch.name !== tagMatch.name)
  const who = idMatch?.name || identifiedName || call.agent_name || `Ext ${call.agent_ext || '?'}`
  const extBit = call.agent_ext ? ` (Ext ${call.agent_ext}${mismatch ? ` — tagged as ${call.agent_name}` : ''})` : ''
  const warn = mismatch ? ' :warning:' : ''

  const text = `${scoreEmoji(salesScore)} ${salesScore}/100 ${outcomeText}${typeText} — ${who}${extBit}${warn} vs ${number}`
  const mention = idMatch?.slack_user_id ? `<@${idMatch.slack_user_id}>` : `*${who}*`
  const direction = call.direction === 'outbound' ? ':arrow_up_small: Outbound' : ':arrow_down_small: Inbound'

  const dims = Object.entries(dimensionScores || {})
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `*${dimensionLabels[k] || k}* ${dimBar(v as number)}  ${v}/10`)
    .join('\n')
  const bullets = (a: any): string => (Array.isArray(a) && a.length ? a.map((s: string) => `• ${s}`).join('\n') : '_None noted_')

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${mention} your call with *${number}* has been analysed.` } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*Score*\n${scoreEmoji(salesScore)} *${salesScore}/100*` },
      { type: 'mrkdwn', text: `*Call type*\n${callTypeLabel(callTypeId) || '—'}` },
      { type: 'mrkdwn', text: `*Outcome*\n${outcomeText}` },
      { type: 'mrkdwn', text: `*Advisor*\n*${who}*${extBit}${warn}` },
      { type: 'mrkdwn', text: `*Direction*\n${direction}` },
      { type: 'mrkdwn', text: `*Duration*\n${duration}` },
    ] },
  ]
  if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Summary*\n${summary.slice(0, 2900)}` } })
  if (dims) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Dimensions*\n${dims}`.slice(0, 2900) } })
  blocks.push({ type: 'section', fields: [
    { type: 'mrkdwn', text: `*✓ Strengths*\n${bullets(observations?.strengths)}`.slice(0, 2000) },
    { type: 'mrkdwn', text: `*△ Improvements*\n${bullets(observations?.improvements)}`.slice(0, 2000) },
  ] })
  const qa = typeof observations?.questions_asked === 'number' ? observations.questions_asked : '—'
  const named = typeof observations?.name_used_count === 'number' ? observations.name_used_count : '—'
  blocks.push({ type: 'context', elements: [{
    type: 'mrkdwn',
    text: `:question: Questions asked: *${qa}* · :bust_in_silhouette: Customer name used: *${named}* · <https://justautos.app/calls?selected=${call.id}|View in portal> · Rubric ${rubricVersion} · $${(costMicroUsd / 1_000_000).toFixed(4)}`,
  }] })

  try {
    const posted = await postMessage({ channel, text, blocks })
    return !!posted
  } catch (e: any) {
    console.error('[calls-analysis] slack post failed:', e?.message || e)
    return false
  }
}

// ── Prompt assembly ──────────────────────────────────────────────────────

function buildPrompt(rubric: RubricRow, call: any, transcriptText: string, roster: RosterRow[]): string {
  const rosterText = roster.map(r => {
    const alias = r.aliases?.length ? ` (also: ${r.aliases.join(', ')})` : ''
    const exts = r.extensions?.length ? ` — usual ext ${r.extensions.join('/')}` : ''
    return `${r.name}${alias}${exts}`
  }).join('\n')

  const duration = call.billsec_seconds || call.duration_seconds || 0
  return rubric.prompt_template
    .replace('{company_context}', rubric.company_context || '')
    .replace('{direction}', call.direction || 'unknown')
    .replace('{agent_name}', call.agent_name || call.agent_ext || 'unknown')
    .replace('{customer_number}', call.external_number || 'unknown')
    .replace('{duration}', `${duration} seconds`)
    .replace('{roster}', rosterText)
    .replace('{call_types}', rubric.call_types?.length ? renderCallTypes(rubric.call_types) : '')
    .replace('{transcript}', transcriptText)
}

// ── Single-call analysis ─────────────────────────────────────────────────

export async function analyseCall(callId: string, opts: { dryRun?: boolean; rubricVersion?: string | null } = {}): Promise<AnalyseResult> {
  const c = sb()
  const dryRun = !!opts.dryRun

  const { data: call, error: callErr } = await c.from('calls')
    .select('id, direction, external_number, agent_ext, agent_name, duration_seconds, billsec_seconds, effective_advisor_source, effective_advisor_slack_user_id')
    .eq('id', callId).maybeSingle()
  if (callErr || !call) return { callId, ok: false, error: callErr?.message || 'call not found' }

  const seconds = call.billsec_seconds || call.duration_seconds || 0
  if (seconds < MIN_SECONDS) return { callId, ok: false, skipped: `call is ${seconds}s (<${MIN_SECONDS}s)` }

  const { data: transcript } = await c.from('call_transcripts')
    .select('id, full_text, segments')
    .eq('call_id', callId).order('transcribed_at', { ascending: false }).limit(1).maybeSingle()
  if (!transcript) return { callId, ok: false, skipped: 'no transcript' }

  const transcriptText = formatTranscript(transcript.segments, transcript.full_text)
  if (!transcriptText.trim()) return { callId, ok: false, skipped: 'empty transcript' }

  const rubric = await getRubric(opts.rubricVersion)
  const roster = await getRoster(c)
  const prompt = buildPrompt(rubric, call, transcriptText, roster)

  let parsed: any, model: string, inputTokens: number, outputTokens: number, costMicroUsd: number, raw: any
  try {
    ({ parsed, model, inputTokens, outputTokens, costMicroUsd, raw } = await callClaude(prompt))
  } catch (e: any) {
    return { callId, ok: false, error: (e?.message || String(e)).slice(0, 300) }
  }

  let callType: RubricCallType | null, salesScore: number | null
  try {
    ({ callType, salesScore } = validateParsed(parsed, rubric))
  } catch (e: any) {
    return { callId, ok: false, error: `validation: ${e?.message || e}` }
  }

  const observations = parsed.observations || {}
  const advisorName = observations.agent_identified_name ?? null
  const advisorConfidence = observations.agent_identified_confidence ?? null

  if (dryRun) {
    return {
      callId, ok: true, callType: callType?.id ?? null, outcome: parsed.outcome, salesScore,
      advisor: { identified: advisorName, confidence: advisorConfidence, applied: false, reason: 'dry run' },
      costMicroUsd, parsed,
    }
  }

  const { data: inserted, error: insErr } = await c.from('call_analysis').insert({
    call_id: callId,
    transcript_id: transcript.id,
    rubric_version: rubric.version,
    model,
    outcome: parsed.outcome,
    outcome_confidence: typeof parsed.outcome_confidence === 'number' ? parsed.outcome_confidence : null,
    sales_score: salesScore,
    dimension_scores: salesScore == null ? null : parsed.dimension_scores,
    observations,
    summary: parsed.summary || null,
    call_type: callType?.id ?? null,
    call_type_confidence: typeof parsed.call_type_confidence === 'number' ? parsed.call_type_confidence : null,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_micro_usd: costMicroUsd,
    analysed_at: new Date().toISOString(),
    raw_response: raw,
  }).select('id').single()
  if (insErr) return { callId, ok: false, error: `insert failed: ${insErr.message}` }

  // Mirror the coaching columns onto calls — reports + the MCP tool read these.
  await c.from('calls').update({
    sales_score: salesScore,
    outcome_classification: parsed.outcome,
    coaching_summary: parsed.summary || null,
    objections_raised: observations.objections_raised || [],
    analysed_at: new Date().toISOString(),
  }).eq('id', callId)

  const advisor = await applyAdvisor(c, call, roster, advisorName, advisorConfidence)

  const dimensionLabels: Record<string, string> = {}
  for (const d of (callType?.dimensions || (Array.isArray(rubric.dimensions) ? rubric.dimensions : []))) {
    if (d?.id) dimensionLabels[d.id] = d.label || d.id
  }

  const slacked = await postCoachingSlack({
    call, outcome: parsed.outcome, callTypeId: callType?.id ?? null, salesScore,
    summary: parsed.summary || null, identifiedName: advisorName, roster,
    dimensionScores: salesScore == null ? null : parsed.dimension_scores,
    dimensionLabels, rubricVersion: rubric.version, costMicroUsd, observations,
  })

  // Close out any queued job rows for this call so the UI stops polling.
  await c.from('analysis_jobs').update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('call_id', callId).in('status', ['pending', 'processing'])

  return { callId, ok: true, callType: callType?.id ?? null, outcome: parsed.outcome, salesScore, advisor, costMicroUsd, analysisId: inserted.id, slacked }
}

// ── Sweep (cron) ─────────────────────────────────────────────────────────
// Two sources, requested jobs first:
//   1. analysis_jobs rows (manual "Analyse this call" clicks / re-runs)
//   2. transcribed calls ≥60s with no analysis yet (the automatic pipeline)

export interface SweepOutcome {
  enabled: boolean
  dryRun: boolean
  rubricVersion: string
  processed: AnalyseResult[]
  candidatesSeen: number
}

export async function runAnalysisSweep(opts: { dryRun?: boolean; limit?: number; rubricVersion?: string | null } = {}): Promise<SweepOutcome> {
  const c = sb()
  const dryRun = !!opts.dryRun
  const limit = Math.max(1, Math.min(Number(opts.limit) || 8, 20))
  const enabled = callsAnalysisEnabled()
  const rubric = await getRubric(opts.rubricVersion)
  const out: SweepOutcome = { enabled, dryRun, rubricVersion: rubric.version, processed: [], candidatesSeen: 0 }
  if (!enabled && !dryRun) return out

  const ids: string[] = []

  // 1. Requested jobs — claim atomically (the second .eq('status','pending')
  // in the UPDATE means an overlapping run claims disjoint rows).
  if (!dryRun) {
    const { data: pending } = await c.from('analysis_jobs')
      .select('id, call_id').eq('status', 'pending')
      .order('created_at', { ascending: true }).limit(limit)
    if (pending?.length) {
      const { data: claimed } = await c.from('analysis_jobs')
        .update({ status: 'processing', claimed_at: new Date().toISOString(), claimed_by: 'portal' })
        .in('id', pending.map(j => j.id)).eq('status', 'pending')
        .select('call_id')
      for (const j of claimed || []) if (j.call_id && !ids.includes(j.call_id)) ids.push(j.call_id)
    }
  }

  // 2. Automatic: recent transcribed calls without an analysis row.
  if (ids.length < limit) {
    const { data: candidates } = await c.from('call_transcripts')
      .select('call_id, calls!inner(id, billsec_seconds, duration_seconds, call_date)')
      .order('transcribed_at', { ascending: false })
      .limit(200)
    const candidateIds = Array.from(new Set((candidates || []).map((r: any) => r.call_id))).filter(Boolean)
    out.candidatesSeen = candidateIds.length
    if (candidateIds.length) {
      const { data: analysed } = await c.from('call_analysis').select('call_id').in('call_id', candidateIds)
      const done = new Set((analysed || []).map((r: any) => r.call_id))
      for (const r of candidates || []) {
        if (ids.length >= limit) break
        const call: any = Array.isArray((r as any).calls) ? (r as any).calls[0] : (r as any).calls
        const secs = call?.billsec_seconds || call?.duration_seconds || 0
        if (!done.has((r as any).call_id) && secs >= MIN_SECONDS && !ids.includes((r as any).call_id)) ids.push((r as any).call_id)
      }
    }
  }

  for (const id of ids.slice(0, limit)) {
    const res = await analyseCall(id, { dryRun, rubricVersion: opts.rubricVersion })
    out.processed.push(res)
    if (!dryRun && !res.ok && res.error) {
      await c.from('analysis_jobs').update({ status: 'failed', failed_at: new Date().toISOString(), error_message: res.error.slice(0, 300) })
        .eq('call_id', id).eq('status', 'processing')
    }
    if (!dryRun && !res.ok && res.skipped) {
      await c.from('analysis_jobs').update({ status: 'skipped', completed_at: new Date().toISOString(), error_message: res.skipped })
        .eq('call_id', id).eq('status', 'processing')
    }
  }

  return out
}

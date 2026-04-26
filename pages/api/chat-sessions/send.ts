// pages/api/chat-sessions/send.ts
// POST — send a user message; creates a new session if sessionId not provided,
// persists user + assistant messages, and returns the reply.
//
// Request body:
//   { sessionId?: string, message: string, contextPage?: string, contextData?: object }
//
// Response:
//   { session: {...}, userMessage: {...}, assistantMessage: {...} }
//
// The LLM sees full session history on every call — that's what gives it
// continuity across messages within a conversation.

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

export const config = { maxDuration: 45 }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

// Build a system prompt that's aware of which portal page the user is on.
// This gives the assistant just enough context to be helpful without flooding
// the context window with every possible data set.
function buildSystemPrompt(contextPage: string | undefined, contextData: any): string {
  const base = `You are the Just Autos management assistant, embedded in the JA Portal. You help Chris and his team understand live business data across two entities:
- JAWS (Just Autos Wholesale & Service) — wholesale/distribution
- VPS (Vehicle Performance Solutions) — workshop

GUIDELINES:
- Be concise. Bullet points over prose where appropriate.
- All $ amounts in the portal are EX-GST by default (users can toggle to inc-GST).
- Use Australian dollar formatting (e.g. $51,233 or $51,233.45).
- Financial year is Australian (July–June).
- If asked about a specific number, cite which entity/period it's from.
- If you don't have the answer in the context provided, say so rather than guessing.`

  const pageHints: Record<string, string> = {
    '/':              'User is on the landing page (redirector to their first visible tab — they should not normally see this).',
    '/overview':      'User is on the customisable Overview dashboard — a 12-col widget grid with named layouts. contextData includes the active layout name, list of widgets, and the data each widget is currently rendering. Use this to answer "what does my dashboard show" / "what is widget X telling me right now" — refer to widgets by their title.',
    '/dashboard':     'User is on the legacy combined Overview/Dashboard page — sections for Overview, Invoices, P&L, Stock, Payables across both JAWS and VPS. contextData includes receivables, income, COS, net, top customers, open bills, stock value for each entity.',
    '/distributors':  'User is on the Distributors page — distributor-level revenue (Tuning + Oil + Parts) for a date range. contextData includes the selected distributor, top 15 distributors by revenue, group totals (by type or region dimension), monthly trend, and any active drill-down. Note: Kenwick and Rockingham are separate distributors; JMACX and HQ Builds are the same company listed separately.',
    '/sales':         'User is on the Sales/Leads page (Monday.com data) — workshop quotes pipeline + distributor orders. contextData has the active view (workshop or distributor), pipeline KPIs (won/lost/win-rate/pipeline value), per-rep breakdown, top active leads, and the distributor orders breakdown.',
    '/calls':         'User is on the Phone Calls page (FreePBX CDR + Deepgram transcripts). contextData includes today/week call stats, top agents by talk time, the calls currently listed (up to 25), and the selected call if one is opened. Speaker 0 in transcripts = Agent. Coaching is post-call only.',
    '/reports':       'User is on the Reports page — generated multi-section reports with optional AI narrative. contextData has the report title, type, period, and section list.',
    '/todos':         'User is on the To-Dos dashboard — aggregates 6 manager Monday.com boards. contextData has per-manager scorecards (open/critical/completed/avg-age), critical open list (oldest first), and recently completed feed.',
    '/stock':         'User is on the Stock & Inventory page (MYOB JAWS items). contextData has totals (stock value, low/out/dead counts, reorder suggestions), critical reorder list (items running out within 30 days), top dead stock, and top velocity items.',
    '/jobs':          'User is on the Jobs page — workshop job tracking.',
    '/vehicle-sales': 'User is on the Vehicle Sales page — vehicle inventory and sales tracking.',
    '/job-reports':   'User is on the Job Reports page — generated reports for completed workshop jobs.',
    '/supplier-invoices': 'User is on the Supplier Invoices page — accounts payable workflow.',
    '/settings':      'User is on the Settings page — user/group management, preferences, VIN codes, distributor groups.',
  }

  const pageContext = contextPage && pageHints[contextPage]
    ? `\nCURRENT PAGE CONTEXT:\n${pageHints[contextPage]}`
    : ''

  const dataContext = contextData && typeof contextData === 'object'
    ? `\nPAGE-SPECIFIC DATA (current view):\n${JSON.stringify(contextData, null, 2).slice(0, 16000)}`
    : ''

  return base + pageContext + dataContext
}

// Auto-generate a session title from the first user message (first 60 chars).
function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 60) return cleaned
  return cleaned.slice(0, 57) + '...'
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const { sessionId, message, contextPage, contextData } = req.body || {}
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' })
  }
  const trimmedMsg = message.trim()

  const sb = getAdmin()

  // ── 1) Resolve the session — create if not provided ─────────────────
  let activeSessionId: string = sessionId
  let sessionCreated = false
  if (!activeSessionId || typeof activeSessionId !== 'string') {
    const { data: newSession, error: createErr } = await sb
      .from('chat_sessions')
      .insert({ user_id: user.id, title: deriveTitle(trimmedMsg) })
      .select()
      .single()
    if (createErr) return res.status(500).json({ error: createErr.message })
    activeSessionId = newSession.id
    sessionCreated = true
  } else {
    // Verify session exists and belongs to user
    const { data: existingSession, error: sErr } = await sb
      .from('chat_sessions')
      .select('id, user_id, title')
      .eq('id', activeSessionId)
      .maybeSingle()
    if (sErr) return res.status(500).json({ error: sErr.message })
    if (!existingSession) return res.status(404).json({ error: 'Session not found' })
    if (existingSession.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' })

    // If session has default title and this is first real exchange, update title
    if (existingSession.title === 'New conversation') {
      await sb
        .from('chat_sessions')
        .update({ title: deriveTitle(trimmedMsg) })
        .eq('id', activeSessionId)
    }
  }

  // ── 2) Save the user message ────────────────────────────────────────
  const { data: userMessage, error: umErr } = await sb
    .from('chat_messages')
    .insert({
      session_id: activeSessionId,
      role: 'user',
      content: trimmedMsg,
      context_page: contextPage || null,
      context_data: contextData || null,
    })
    .select()
    .single()
  if (umErr) return res.status(500).json({ error: umErr.message })

  // ── 3) Load full history (for the LLM to see continuity) ────────────
  const { data: history, error: histErr } = await sb
    .from('chat_messages')
    .select('role, content')
    .eq('session_id', activeSessionId)
    .order('created_at', { ascending: true })
    .limit(50)  // cap context window
  if (histErr) return res.status(500).json({ error: histErr.message })

  const llmMessages = (history || []).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  // ── 4) Call Claude ──────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(contextPage, contextData)

  let assistantReply: string
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: llmMessages,
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      console.error('Anthropic API error:', response.status, errText.substring(0, 300))
      assistantReply = `AI error (${response.status}): ${errText.substring(0, 150)}`
    } else {
      const data = await response.json()
      assistantReply = data.content?.find((b: any) => b.type === 'text')?.text
        || 'Sorry, I could not generate a response.'
    }
  } catch (err: any) {
    console.error('Claude call failed:', err.message)
    assistantReply = `Connection error: ${err.message}`
  }

  // ── 5) Save the assistant response ──────────────────────────────────
  const { data: assistantMessage, error: amErr } = await sb
    .from('chat_messages')
    .insert({
      session_id: activeSessionId,
      role: 'assistant',
      content: assistantReply,
      context_page: contextPage || null,
    })
    .select()
    .single()
  if (amErr) return res.status(500).json({ error: amErr.message })

  // Refetch session to get latest title/updated_at
  const { data: finalSession } = await sb
    .from('chat_sessions')
    .select('id, title, created_at, updated_at')
    .eq('id', activeSessionId)
    .single()

  return res.status(200).json({
    session: finalSession,
    sessionCreated,
    userMessage,
    assistantMessage,
  })
}

export default withAuth(null, handler)

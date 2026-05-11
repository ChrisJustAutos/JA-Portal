// lib/slack-bot/claude.ts
//
// Calls Anthropic Messages API in an agentic loop: send question + tools,
// if Claude requests tools execute them, feed results back, repeat until
// stop_reason='end_turn'.

import Anthropic from '@anthropic-ai/sdk'
import { TOOLS, TOOLS_BY_NAME } from './tools'

const SYSTEM_PROMPT = `You are the JA Portal Assistant, an internal Slack bot for Just Autos Mechanical — a Sydney-based automotive workshop and parts business.

Business context:
- Two MYOB company files: **JAWS** (Just Autos Workshop Services, retail customers + workshop) and **VPS** (Vehicle Performance Specialists, B2B parts). Always default to JAWS unless the user specifies VPS.
- Stripe accounts: JAWS-ET (retail e-commerce) and JAWS-JMACX (workshop card payments). Both feed into JAWS MYOB.
- Mechanics Desk is the job-management system. Stock alerts from MD feed the Monday "Product Availability Delays" board.
- Workshop specialises in Toyota Land Cruiser / Prado / Hilux parts. Common platforms: FJA300 (LC300), VDJ200 (LC200), VDJ70/GDJ70 (70 Series), GDJ250 (Prado), GUN126R (Hilux).

How to answer:
- Be concise. Slack messages are read on phones. Use bullet points for lists.
- When users ask about live data (customers, invoices, stock, delays), CALL the appropriate tool first — don't guess.
- For general "how do I" questions, answer from the context above. If you don't know, say so.
- Format dollar values like $1,234.56. Format invoice numbers like #12345.
- Don't expose technical UIDs or internal IDs unless directly asked.`

export interface AskResult {
  text: string
  toolsUsed: string[]
  inputTokens: number
  outputTokens: number
}

export async function askClaude(question: string): Promise<AskResult> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey: key })

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: question },
  ]

  const toolDefs = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))

  const toolsUsed: string[] = []
  let totalIn = 0
  let totalOut = 0

  for (let iter = 0; iter < 6; iter++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      tools: toolDefs as any,
      messages,
    })

    totalIn += resp.usage?.input_tokens || 0
    totalOut += resp.usage?.output_tokens || 0

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      const text = resp.content
        .filter(b => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim()
      return { text: text || '(no answer)', toolsUsed, inputTokens: totalIn, outputTokens: totalOut }
    }

    if (resp.stop_reason !== 'tool_use') {
      return { text: `(stopped: ${resp.stop_reason})`, toolsUsed, inputTokens: totalIn, outputTokens: totalOut }
    }

    // Echo assistant message back into the convo
    messages.push({ role: 'assistant', content: resp.content as any })

    // Execute each tool_use block, gather tool_result blocks
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue
      toolsUsed.push(block.name)
      const def = TOOLS_BY_NAME[block.name]
      let output: string
      if (!def) {
        output = `Tool "${block.name}" not found.`
      } else {
        try {
          output = await def.execute(block.input)
        } catch (e: any) {
          output = `Error running ${block.name}: ${e?.message || String(e)}`
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output.slice(0, 4000),
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { text: '(hit max iteration limit — try a simpler question)', toolsUsed, inputTokens: totalIn, outputTokens: totalOut }
}

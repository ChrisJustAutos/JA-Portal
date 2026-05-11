// pages/api/slack/ask.ts
//
// Webhook for the JA Portal Slack bot. Handles two trigger types:
//   1. app_mention events  — body.type === 'event_callback', event.type === 'app_mention'
//   2. /ask slash commands — Content-Type application/x-www-form-urlencoded with command + text
//
// Slack requires a response within 3 seconds. We:
//   - For URL-verification handshake → respond synchronously with the challenge.
//   - For real triggers → ack 200 immediately, then call Claude + post answer
//     via chat.postMessage from inside the same function (Vercel keeps the
//     function alive until it returns; maxDuration set below).

import type { NextApiRequest, NextApiResponse } from 'next'
import { verifySlackSignature } from '../../../lib/slack-bot/verify'
import { askClaude } from '../../../lib/slack-bot/claude'
import { postMessage } from '../../../lib/slack-bot/slack'

export const config = {
  api: { bodyParser: false },
  maxDuration: 120,
}

async function readRawBody(req: NextApiRequest): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim()
}

// Coarse in-memory dedupe — Slack retries events on 3s timeout. Survives
// only as long as the warm function instance, which is fine for "ignore the
// retry of the same event id we just answered".
const recentEventIds = new Set<string>()
function rememberEvent(id: string): boolean {
  if (recentEventIds.has(id)) return false
  recentEventIds.add(id)
  if (recentEventIds.size > 200) {
    const first = recentEventIds.values().next().value
    if (first) recentEventIds.delete(first)
  }
  return true
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' })

  const raw = await readRawBody(req)
  const ts = req.headers['x-slack-request-timestamp'] as string | undefined
  const sig = req.headers['x-slack-signature'] as string | undefined
  const verify = verifySlackSignature(raw, ts, sig)
  if (!verify.ok) {
    console.warn('[slack/ask] signature rejected:', verify.reason)
    return res.status(401).json({ error: 'bad-signature', reason: verify.reason })
  }

  const ct = (req.headers['content-type'] || '').toLowerCase()

  // ── Slash command (/ask) — form encoded ──────────────────────────────
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw)
    const text = (params.get('text') || '').trim()
    const channel = params.get('channel_id') || ''
    const user = params.get('user_id') || ''
    const responseUrl = params.get('response_url') || ''

    if (!text) {
      return res.status(200).json({ response_type: 'ephemeral', text: 'Usage: `/ask <your question>`' })
    }

    // Ack immediately with a placeholder so Slack doesn't time out.
    res.status(200).json({
      response_type: 'in_channel',
      text: `:hourglass_flowing_sand: <@${user}> asked: _${text}_`,
    })

    // Process and post final answer.
    try {
      const result = await askClaude(text)
      const reply = result.text + (result.toolsUsed.length ? `\n\n_Used: ${result.toolsUsed.join(', ')}_` : '')
      if (responseUrl) {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response_type: 'in_channel', replace_original: false, text: reply }),
        })
      } else if (channel) {
        await postMessage({ channel, text: reply })
      }
    } catch (e: any) {
      console.error('[slack/ask] slash-command error:', e)
      if (responseUrl) {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', text: `:warning: Error: ${e?.message || String(e)}` }),
        })
      }
    }
    return
  }

  // ── Events API — JSON ────────────────────────────────────────────────
  let body: any
  try { body = JSON.parse(raw) } catch { return res.status(400).json({ error: 'bad-json' }) }

  // URL-verification handshake (run once when adding the Events URL in Slack).
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  if (body.type !== 'event_callback' || !body.event) {
    return res.status(200).json({ ok: true })
  }

  const event = body.event
  const eventId: string = body.event_id || `${event.channel}:${event.ts}`

  // Ignore bot messages (including our own) and dedupe retries.
  if (event.bot_id || event.subtype === 'bot_message') return res.status(200).json({ ok: true })
  if (!rememberEvent(eventId)) return res.status(200).json({ ok: true })

  if (event.type !== 'app_mention') {
    return res.status(200).json({ ok: true })
  }

  const question = stripBotMention(event.text || '')
  const channel: string = event.channel
  const threadTs: string | undefined = event.thread_ts || event.ts

  // Ack Slack immediately.
  res.status(200).json({ ok: true })

  try {
    const result = await askClaude(question || 'Hi — what can you help me with?')
    const reply = result.text + (result.toolsUsed.length ? `\n\n_Used: ${result.toolsUsed.join(', ')}_` : '')
    await postMessage({ channel, text: reply, thread_ts: threadTs })
  } catch (e: any) {
    console.error('[slack/ask] mention error:', e)
    await postMessage({
      channel,
      text: `:warning: I hit an error: ${e?.message || String(e)}`,
      thread_ts: threadTs,
    })
  }
}

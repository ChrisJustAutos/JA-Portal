// pages/api/slack/ask.ts
//
// Webhook for the JA Portal Slack bot. Handles three trigger types:
//   1. message events      — any human post in an allowed channel; staff ask
//      naturally with NO @mention. Un-addressed messages pass through a silent
//      gate (Claude returns NO_REPLY on chatter) so the bot only speaks up for
//      a real request. Requires the message.channels event + channels:history.
//   2. app_mention events  — a direct @mention; always answered (no gate).
//   3. /ask slash commands — Content-Type application/x-www-form-urlencoded with command + text
//
// Slack requires a response within 3 seconds. We:
//   - For URL-verification handshake → respond synchronously with the challenge.
//   - For real triggers → ack 200 immediately, then call Claude + post answer
//     via chat.postMessage from inside the same function (Vercel keeps the
//     function alive until it returns; maxDuration set below).

import type { NextApiRequest, NextApiResponse } from 'next'
import { waitUntil } from '@vercel/functions'
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

// Restrict the bot to specific channel IDs via SLACK_ALLOWED_CHANNEL_IDS
// (comma-separated). If unset, all channels are allowed.
function isAllowedChannel(channelId: string): boolean {
  const raw = (process.env.SLACK_ALLOWED_CHANNEL_IDS || '').trim()
  if (!raw) return true
  const allow = raw.split(',').map(s => s.trim()).filter(Boolean)
  return allow.includes(channelId)
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

    if (!isAllowedChannel(channel)) {
      return res.status(200).json({
        response_type: 'ephemeral',
        text: ':lock: The JA Portal Assistant only works in #ja-portal-queries. Head over there and try again.',
      })
    }

    // Hand the slow work off to waitUntil so Vercel keeps the function
    // alive after we ack Slack within 3s.
    waitUntil((async () => {
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
    })())

    // Ack immediately with a placeholder so Slack doesn't time out.
    return res.status(200).json({
      response_type: 'in_channel',
      text: `:hourglass_flowing_sand: <@${user}> asked: _${text}_`,
    })
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

  // We handle two event types: app_mention (someone @mentions the bot) and
  // message (any post in a channel the bot is in — so staff can just ask the
  // question with no @mention). A single message can fire BOTH, so dedupe on
  // the message identity (channel+ts), NOT the per-event id.
  if (event.type !== 'app_mention' && event.type !== 'message') {
    return res.status(200).json({ ok: true })
  }

  // Ignore anything the bot itself said and non-plain messages (edits, deletes,
  // joins, bot posts, file-share subtypes) — only real human messages.
  if (event.bot_id || event.subtype) return res.status(200).json({ ok: true })

  const channel: string = event.channel
  if (!isAllowedChannel(channel)) return res.status(200).json({ ok: true })

  const dedupeKey = `${event.channel}:${event.ts}`
  if (!rememberEvent(dedupeKey)) return res.status(200).json({ ok: true })

  // Treat it as "directly addressed" if it's an app_mention OR the text carries
  // a bot mention (the message-event copy of a mention) — those are always
  // answered. Un-addressed messages go through the silent gate.
  const hasMention = /<@[A-Z0-9]+>/.test(event.text || '')
  const directlyAddressed = event.type === 'app_mention' || hasMention

  const question = stripBotMention(event.text || '').trim()
  if (!question) return res.status(200).json({ ok: true })
  const threadTs: string | undefined = event.thread_ts || event.ts

  // Run Claude + post in background so we can ack Slack within 3s.
  waitUntil((async () => {
    try {
      const result = await askClaude(question, { gateSilent: !directlyAddressed })
      const answer = result.text.trim()
      // Silent gate: for un-addressed channel chatter Claude returns NO_REPLY —
      // stay quiet rather than butting in.
      if (!directlyAddressed && /^NO_REPLY\b/i.test(answer)) return
      const reply = (answer || '(no answer)') + (result.toolsUsed.length ? `\n\n_Used: ${result.toolsUsed.join(', ')}_` : '')
      await postMessage({ channel, text: reply, thread_ts: threadTs })
    } catch (e: any) {
      console.error('[slack/ask] event error:', e)
      // Only surface errors when directly addressed — never spam an error into
      // the channel over a message we weren't even asked to answer.
      if (directlyAddressed) {
        await postMessage({
          channel,
          text: `:warning: I hit an error: ${e?.message || String(e)}`,
          thread_ts: threadTs,
        })
      }
    }
  })())

  return res.status(200).json({ ok: true })
}

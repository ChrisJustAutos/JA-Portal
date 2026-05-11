// lib/slack-bot/slack.ts
//
// Thin wrapper around Slack Web API — chat.postMessage and chat.update.
// Auth: bot token from SLACK_BOT_TOKEN env var.

const SLACK_API = 'https://slack.com/api'

function botToken(): string {
  const t = process.env.SLACK_BOT_TOKEN
  if (!t) throw new Error('SLACK_BOT_TOKEN not set')
  return t
}

export async function postMessage(args: {
  channel: string
  text: string
  thread_ts?: string
  blocks?: any[]
}): Promise<{ ts: string; channel: string } | null> {
  const r = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken()}`,
    },
    body: JSON.stringify(args),
  })
  const j: any = await r.json()
  if (!j.ok) {
    console.error('[slack.postMessage] failed:', j)
    return null
  }
  return { ts: j.ts, channel: j.channel }
}

export async function updateMessage(args: {
  channel: string
  ts: string
  text: string
  blocks?: any[]
}): Promise<boolean> {
  const r = await fetch(`${SLACK_API}/chat.update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken()}`,
    },
    body: JSON.stringify(args),
  })
  const j: any = await r.json()
  if (!j.ok) console.error('[slack.update] failed:', j)
  return !!j.ok
}

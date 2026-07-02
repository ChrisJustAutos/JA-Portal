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

// Delete one of the bot's own messages. Treats an already-gone message as
// success so the auto-delete sweeper doesn't retry it forever.
export async function deleteMessage(args: { channel: string; ts: string }): Promise<boolean> {
  const r = await fetch(`${SLACK_API}/chat.delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken()}`,
    },
    body: JSON.stringify(args),
  })
  const j: any = await r.json()
  if (!j.ok && j.error !== 'message_not_found') console.error('[slack.delete] failed:', j)
  return !!j.ok || j.error === 'message_not_found'
}

// Open (or fetch) the bot's DM channel with a user. Needs the im:write scope.
async function openDm(userId: string): Promise<string | null> {
  const r = await fetch(`${SLACK_API}/conversations.open`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken()}`,
    },
    body: JSON.stringify({ users: userId }),
  })
  const j: any = await r.json()
  if (!j.ok) { console.error('[slack.openDm] failed:', j); return null }
  return j.channel?.id || null
}

// Deliver a message to the configured parts contact (SLACK_PARTS_CONTACT):
// a user id (U…/W… → DM the person, e.g. Terry) or a channel id (C…/G… → post
// to that channel). Used by the "Ask about ETA/availability" button.
export async function sendToPartsContact(text: string): Promise<{ ok: boolean; reason?: string }> {
  const contact = (process.env.SLACK_PARTS_CONTACT || '').trim()
  if (!contact) return { ok: false, reason: 'no contact configured (set SLACK_PARTS_CONTACT)' }
  let channel = contact
  if (/^[UW]/.test(contact)) {
    const dm = await openDm(contact)
    if (!dm) return { ok: false, reason: 'could not open a DM (bot may need the im:write scope)' }
    channel = dm
  }
  const posted = await postMessage({ channel, text })
  return posted ? { ok: true } : { ok: false, reason: 'Slack rejected the message' }
}

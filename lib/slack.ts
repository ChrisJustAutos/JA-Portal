// lib/slack.ts
// Minimal Slack incoming-webhook sender. One webhook URL per channel,
// stored in env vars. We pass Block Kit blocks for nicer formatting but
// also include a plain `text` fallback (required by Slack for the
// notification preview).

export interface SlackBlock { [k: string]: any }

export interface SlackPayload {
  text: string                  // fallback / notification preview
  blocks?: SlackBlock[]
  username?: string
  iconEmoji?: string
}

export async function postWebhook(
  webhookUrl: string,
  payload: SlackPayload,
): Promise<{ ok: boolean; status: number; body: string }> {
  const body: Record<string, any> = { text: payload.text }
  if (payload.blocks) body.blocks = payload.blocks
  if (payload.username) body.username = payload.username
  if (payload.iconEmoji) body.icon_emoji = payload.iconEmoji

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const responseBody = await res.text()
  return { ok: res.ok, status: res.status, body: responseBody.slice(0, 300) }
}

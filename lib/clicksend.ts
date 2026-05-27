// lib/clicksend.ts
// ClickSend SMS client. POST https://rest.clicksend.com/v3/sms/send with HTTP
// Basic auth (username:api_key). Env:
//   CLICKSEND_USERNAME, CLICKSEND_API_KEY, CLICKSEND_FROM (optional sender id).
// Sending is a no-op error ('clicksend_not_configured') until the creds are set
// in Vercel env, so nothing breaks before then.

const CLICKSEND_URL = 'https://rest.clicksend.com/v3/sms/send'

export function clicksendConfigured(): boolean {
  return !!(process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_API_KEY)
}

// Normalise an AU number to E.164 (+61…). Returns null if it doesn't look valid.
export function toE164AU(raw: string | null | undefined): string | null {
  if (!raw) return null
  const n = String(raw).replace(/[^\d+]/g, '')
  if (!n) return null
  if (n.startsWith('+')) return n.length >= 11 ? n : null
  if (n.startsWith('61')) return '+' + n
  if (n.startsWith('0')) return '+61' + n.slice(1)
  if (n.length === 9 && n.startsWith('4')) return '+61' + n
  return null
}

export interface SmsResult { ok: boolean; messageId?: string; error?: string }

export async function sendSms(to: string | null | undefined, body: string, from?: string | null): Promise<SmsResult> {
  const user = process.env.CLICKSEND_USERNAME
  const key = process.env.CLICKSEND_API_KEY
  if (!user || !key) return { ok: false, error: 'clicksend_not_configured' }
  const e164 = toE164AU(to)
  if (!e164) return { ok: false, error: 'invalid_number' }
  const auth = Buffer.from(`${user}:${key}`).toString('base64')
  try {
    const r = await fetch(CLICKSEND_URL, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ source: 'ja-portal', to: e164, body: String(body).slice(0, 1000), from: from || process.env.CLICKSEND_FROM || undefined }] }),
    })
    const data: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: `clicksend HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}` }
    const msg = data?.data?.messages?.[0]
    if (msg && String(msg.status || '').toUpperCase() !== 'SUCCESS') {
      return { ok: false, error: String(msg.status || 'send_failed'), messageId: msg.message_id }
    }
    return { ok: true, messageId: msg?.message_id }
  } catch (e: any) { return { ok: false, error: e?.message || 'send_error' } }
}

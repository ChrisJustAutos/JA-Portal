// lib/pbx-live.ts
//
// Client for the FreePBX-side "live monitoring" service. Live call data and
// ChanSpy control need a persistent connection to Asterisk (AMI/ARI), which
// Vercel's serverless functions can't hold — so a small service runs ON the
// FreePBX box (alongside ja-cdr-sync) and exposes two HTTPS endpoints that we
// call here. Configure with env:
//
//   PBX_LIVE_URL    e.g. https://pbx.justautos.internal:8443
//   PBX_LIVE_TOKEN  shared bearer secret (also set on the PBX service)
//
// ── Contract the PBX-side service must implement ─────────────────────────
//
//   GET  {PBX_LIVE_URL}/live/channels
//        Auth: "Authorization: Bearer <PBX_LIVE_TOKEN>"
//        → 200 { "calls": LiveCall[] }   (only answered/active agent legs)
//
//   POST {PBX_LIVE_URL}/live/spy
//        Auth: bearer
//        body { listener_extension, target_channel, mode }
//        mode: "listen" | "whisper" | "barge"
//        Behaviour: verify listener_extension is currently registered; if so,
//        Originate a call to it and on answer run ChanSpy(target_channel,opts)
//          listen  → silent (e.g. ChanSpy opts "q")
//          whisper → add "w"  (manager heard by agent only)
//          barge   → add "B"  (manager heard by both parties)
//        → 200 { ok:true }
//        → 409 { ok:false, error:"not_registered" }  (listener offline)
//        → 4xx/5xx { ok:false, error:"..." }

export interface LiveCall {
  linkedid: string
  channel: string                 // the agent-leg Asterisk channel to spy on
  direction: 'inbound' | 'outbound' | null
  external_number: string | null
  caller_name: string | null
  agent_ext: string | null
  agent_name: string | null
  started_at: string | null       // ISO 8601
  duration_seconds: number | null
  state: string | null            // Asterisk channel state, e.g. "Up"
}

export type SpyMode = 'listen' | 'whisper' | 'barge'

const TIMEOUT_MS = 8000

export function isPbxLiveConfigured(): boolean {
  return !!(process.env.PBX_LIVE_URL && process.env.PBX_LIVE_TOKEN)
}

function baseUrl(): string {
  return (process.env.PBX_LIVE_URL || '').replace(/\/+$/, '')
}

async function pbxFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${process.env.PBX_LIVE_TOKEN}`,
        'Accept': 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Active calls currently in progress. Empty array when nothing's live. */
export async function listLiveChannels(): Promise<LiveCall[]> {
  if (!isPbxLiveConfigured()) throw new Error('PBX live service not configured')
  const r = await pbxFetch('/live/channels')
  if (!r.ok) throw new Error(`PBX live channels failed (HTTP ${r.status})`)
  const data = await r.json().catch(() => ({}))
  return Array.isArray(data?.calls) ? (data.calls as LiveCall[]) : []
}

export interface StartSpyResult {
  ok: boolean
  error?: string   // e.g. "not_registered"
}

/** Ring `listenerExtension` and ChanSpy the target channel in the given mode. */
export async function startSpy(input: {
  listenerExtension: string
  targetChannel: string
  mode: SpyMode
}): Promise<StartSpyResult> {
  if (!isPbxLiveConfigured()) throw new Error('PBX live service not configured')
  const r = await pbxFetch('/live/spy', {
    method: 'POST',
    body: JSON.stringify({
      listener_extension: input.listenerExtension,
      target_channel: input.targetChannel,
      mode: input.mode,
    }),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, error: data?.error || `HTTP ${r.status}` }
  return { ok: data?.ok !== false, error: data?.error }
}

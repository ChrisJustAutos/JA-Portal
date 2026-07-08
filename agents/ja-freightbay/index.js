// agents/ja-freightbay/index.js
//
// Freight Bay alert bridge. Runs as a systemd service on the FreePBX sync host
// (same box as ja-cdr-sync / ja-transcribe). Holds an open connection to the
// Hikvision NVR's ISAPI alert stream and, when a person crosses the line at the
// freight bay DURING BUSINESS HOURS, it:
//   A) rings a dedicated Yealink handset and plays the "freight bay alert"
//      recording (via an Asterisk call file — no AMI creds needed), and
//   B) posts "📦 Parts dropped off at Freight Bay" to Slack with a JPEG
//      snapshot grabbed from the NVR at event time.
//
// Zero external deps — everything is Node built-ins (http/https digest auth,
// multipart stream parse, fetch for Slack). dotenv is loaded if present.
//
// CLI helpers (see README): --probe (log raw events, no actions),
// --test-ring, --test-snapshot, --test-slack, --once.
//
// Setup + systemd unit: see README.md.

try { require('dotenv').config() } catch { /* dotenv optional; systemd EnvironmentFile also works */ }

const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Minimal HTTPS request helper (Slack). Built-in so the service needs no
// global fetch — it runs on Node 16 (the newest Node that supports CentOS 7's
// glibc 2.17). Resolves { status, body: Buffer }.
function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const h = { ...headers }
    if (body != null && h['Content-Length'] == null) h['Content-Length'] = Buffer.byteLength(body)
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h },
      res => {
        const chunks = []
        res.on('data', d => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('https timeout')))
    if (body != null) req.write(body)
    req.end()
  })
}

// ── Config ───────────────────────────────────────────────────────────────
const CFG = {
  nvr: {
    host: process.env.NVR_HOST || '192.168.0.199',
    port: parseInt(process.env.NVR_PORT || '80', 10),
    user: process.env.NVR_USER || '',
    pass: process.env.NVR_PASS || '',
    // D24 → ISAPI channelID (D-number * 100 + 1). Override if --probe shows
    // a different id. Compared loosely so "2401"/2401 both match.
    channelId: String(process.env.NVR_CHANNEL_ID || '2401'),
  },
  alertExt: process.env.ALERT_EXTENSION || '',
  callerId: process.env.ALERT_CALLERID || 'Freight Bay <8000>',
  dialplanContext: process.env.DIALPLAN_CONTEXT || 'freight-bay-alert',
  spoolDir: process.env.ASTERISK_SPOOL_DIR || '/var/spool/asterisk/outgoing',
  // Ring ONCE: one attempt, no retries. WaitTime = seconds it rings unanswered
  // before giving up. Raise CALL_MAX_RETRIES only if you want repeat rings.
  callMaxRetries: process.env.CALL_MAX_RETRIES || '0',
  callRetryTime: process.env.CALL_RETRY_TIME || '30',
  callWaitTime: process.env.CALL_WAIT_TIME || '25',
  slack: {
    token: process.env.SLACK_BOT_TOKEN || '',
    channel: process.env.SLACK_CHANNEL_ID || '',
  },
  tz: process.env.BUSINESS_TZ || 'Australia/Perth',
  // Days: 0=Sun … 6=Sat. Default Mon–Fri.
  days: (process.env.BUSINESS_DAYS || '1,2,3,4,5').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
  startHhmm: process.env.BUSINESS_START || '07:00',
  endHhmm: process.env.BUSINESS_END || '17:00',
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '120000', 10),
  // Event types that count as "someone at the bay".
  eventTypes: (process.env.EVENT_TYPES || 'linedetection,fielddetection').split(',').map(s => s.trim().toLowerCase()),
  reconnectMs: parseInt(process.env.RECONNECT_MS || '2000', 10),
  // Two ways to receive events. PUSH (alarm server) is the reliable path on
  // NVRs that drop the pull-stream: the camera/NVR POSTs events to this
  // listener. Both can run at once — the debounce dedupes. Set
  // USE_ALERTSTREAM=false on a flaky NVR to silence the reconnect churn.
  useAlarmServer: (process.env.USE_ALARM_SERVER || 'true').toLowerCase() !== 'false',
  useAlertStream: (process.env.USE_ALERTSTREAM || 'true').toLowerCase() !== 'false',
  listenPort: parseInt(process.env.LISTEN_PORT || '8098', 10),
  // Snapshot burst posted to Slack after the instant text alert. Frames come
  // from a continuously-running ring buffer (see startFrameBuffer) because the
  // NVR's snapshot endpoint lags the live scene by ~3s — pulling only after
  // the event means a quick visitor is already gone. Pre-roll fixes that.
  burstCount: parseInt(process.env.BURST_COUNT || '6', 10),
  burstIntervalMs: parseInt(process.env.BURST_INTERVAL_MS || '1000', 10),
  burstPreRollMs: parseInt(process.env.BURST_PREROLL_MS || '4000', 10),
  burstPostRollMs: parseInt(process.env.BURST_POSTROLL_MS || '7000', 10),
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const ARGS = new Set(process.argv.slice(2))
function log(...a) { console.log(new Date().toISOString(), ...a) }
function warn(...a) { console.warn(new Date().toISOString(), 'WARN', ...a) }

// ── HTTP Digest auth (Hikvision ISAPI uses Digest) ────────────────────────
function md5(s) { return crypto.createHash('md5').update(s).digest('hex') }

function parseChallenge(header) {
  const out = {}
  // strip leading "Digest "
  const body = header.replace(/^Digest\s+/i, '')
  for (const m of body.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3]
  }
  return out
}

function buildDigestHeader(ch, { method, uri, user, pass }) {
  const cnonce = crypto.randomBytes(8).toString('hex')
  const nc = '00000001'
  const qop = (ch.qop || '').split(',')[0] || undefined
  const ha1 = md5(`${user}:${ch.realm}:${pass}`)
  const ha2 = md5(`${method}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${ch.nonce}:${ha2}`)
  let h = `Digest username="${user}", realm="${ch.realm}", nonce="${ch.nonce}", uri="${uri}", response="${response}"`
  if (ch.opaque) h += `, opaque="${ch.opaque}"`
  if (qop) h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  return h
}

// One-shot digest GET → resolves { status, headers, body:Buffer }.
function digestGet(uri, { binary = false } = {}) {
  const { host, port, user, pass } = CFG.nvr
  return new Promise((resolve, reject) => {
    const first = http.request({ host, port, path: uri, method: 'GET' }, res1 => {
      // Drain the 401 body.
      res1.resume()
      if (res1.statusCode !== 401) {
        // No auth needed (rare) — collect directly.
        return collect(res1, binary).then(body => resolve({ status: res1.statusCode, headers: res1.headers, body })).catch(reject)
      }
      const ch = parseChallenge(res1.headers['www-authenticate'] || '')
      const auth = buildDigestHeader(ch, { method: 'GET', uri, user, pass })
      const second = http.request({ host, port, path: uri, method: 'GET', headers: { Authorization: auth } }, res2 => {
        collect(res2, binary).then(body => resolve({ status: res2.statusCode, headers: res2.headers, body })).catch(reject)
      })
      second.on('error', reject)
      second.end()
    })
    first.on('error', reject)
    first.setTimeout(15000, () => first.destroy(new Error('NVR request timeout')))
    first.end()
  })
}

function collect(res, binary) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', d => chunks.push(d))
    res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

// ── Business hours + debounce ─────────────────────────────────────────────
function hhmmToMinutes(s) { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0) }

function inBusinessHours(d = new Date()) {
  // Resolve weekday + HH:MM in the configured timezone.
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: CFG.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]))
  const dayIdx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[map.weekday]
  if (!CFG.days.includes(dayIdx)) return false
  const mins = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10)
  return mins >= hhmmToMinutes(CFG.startHhmm) && mins < hhmmToMinutes(CFG.endHhmm)
}

let lastFired = 0

// ── Action A — ring the Yealink via an Asterisk call file ──────────────────
function ringPhone() {
  if (!CFG.alertExt) { warn('ALERT_EXTENSION not set — skipping phone ring'); return }
  // ONE attempt, NO retries (MaxRetries 0) — an alert must never runaway-ring
  // when nobody answers. WaitTime = how long it rings before giving up.
  const callFile = [
    `Channel: PJSIP/${CFG.alertExt}`,
    `CallerID: ${CFG.callerId}`,
    `MaxRetries: ${CFG.callMaxRetries}`,
    `RetryTime: ${CFG.callRetryTime}`,
    `WaitTime: ${CFG.callWaitTime}`,
    `Context: ${CFG.dialplanContext}`,
    'Extension: s',
    'Priority: 1',
    '',
  ].join('\n')
  // Write to a temp path OUTSIDE the spool, then mv in so Asterisk only ever
  // sees a complete file (atomic pickup).
  const tmp = path.join('/tmp', `fb-${Date.now()}.call`)
  try {
    fs.writeFileSync(tmp, callFile)
    // Asterisk requires the file to be owned/readable by it; mv preserves that
    // better than a cross-device copy. chown to asterisk if we can.
    const mv = spawnSync('mv', [tmp, path.join(CFG.spoolDir, path.basename(tmp))])
    if (mv.status !== 0) throw new Error(`mv failed: ${mv.stderr?.toString() || mv.status}`)
    log(`Ringing ${CFG.alertExt} via call file`)
  } catch (e) {
    warn('ringPhone failed:', e.message)
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

// ── Action B — NVR snapshot → Slack ────────────────────────────────────────
async function snapshot() {
  // The bare picture endpoint serves a ~4s-stale cached frame on this NVR.
  // Asking for an explicit resolution forces a fresh capture (and gives a
  // sharper 720p image). NOTE: adding snapShotImageType alongside it re-caches.
  const query = process.env.SNAPSHOT_QUERY || '?videoResolutionWidth=1280&videoResolutionHeight=720'
  const uri = `/ISAPI/Streaming/channels/${CFG.nvr.channelId}/picture${query}`
  const r = await digestGet(uri, { binary: true })
  if (r.status !== 200) throw new Error(`snapshot HTTP ${r.status}`)
  if (!r.body || r.body.length < 1024) throw new Error(`snapshot too small (${r.body?.length || 0} bytes)`)
  return r.body
}

function localTimeLabel() {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: CFG.tz, weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date())
}

async function postSlack(jpeg) {
  const { token, channel } = CFG.slack
  const comment = `📦 Parts dropped off at Freight Bay — ${localTimeLabel()}`
  if (!token || !channel) { warn('Slack token/channel not set — skipping Slack'); return }
  // Try the snapshot upload; on ANY failure (missing files:write scope, upload
  // error, snapshot missing) fall back to a text-only post so the alert is
  // never silent. Only chat:write is required for the fallback.
  if (jpeg) {
    try {
      const filename = `freight-bay-${Date.now()}.jpg`
      const up = await slackApi('files.getUploadURLExternal', null, { query: { filename, length: String(jpeg.length) } })
      if (!up.ok) throw new Error(`getUploadURLExternal: ${up.error}`)
      const put = await httpsRequest(up.upload_url, { method: 'POST', body: jpeg, headers: { 'Content-Type': 'image/jpeg' } })
      if (put.status < 200 || put.status >= 300) throw new Error(`upload POST HTTP ${put.status}`)
      const done = await slackApi('files.completeUploadExternal', {
        files: [{ id: up.file_id, title: 'Freight bay snapshot' }],
        channel_id: channel,
        initial_comment: comment,
      })
      if (!done.ok) throw new Error(`completeUploadExternal: ${done.error}`)
      log('Slack posted with snapshot')
      return
    } catch (e) {
      warn(`snapshot post failed (${e.message}) — posting text only. Add the bot's files:write scope for the photo.`)
    }
  }
  const msg = await slackApi('chat.postMessage', { channel, text: comment })
  if (!msg.ok) throw new Error(`chat.postMessage: ${msg.error}`)
  log('Slack posted (text only)')
}

// Instant text alert — no snapshot wait, so the notification lands ASAP.
// Returns the message ts so the photo burst can thread under it.
async function postSlackText() {
  const { token, channel } = CFG.slack
  if (!token || !channel) { warn('Slack token/channel not set — skipping Slack'); return null }
  const msg = await slackApi('chat.postMessage', {
    channel, text: `📦 Parts dropped off at Freight Bay — ${localTimeLabel()}`,
  })
  if (!msg.ok) throw new Error(`chat.postMessage: ${msg.error}`)
  log('Slack alert posted')
  return msg.ts || null
}

// ── Frame ring buffer ──────────────────────────────────────────────────────
// The NVR's snapshot endpoint serves a frame ~3s behind live, so snapping
// only AFTER an event misses quick visitors entirely. Instead we snapshot
// continuously (business hours only) into a small in-memory ring, and the
// burst picks frames spanning [event - preRoll, event + postRoll].
const frameBuf = [] // { ts, jpg }
function startFrameBuffer() {
  const tick = async () => {
    if (inBusinessHours()) {
      try {
        const jpg = await snapshot()
        frameBuf.push({ ts: Date.now(), jpg })
        while (frameBuf.length > 20) frameBuf.shift()
      } catch { /* NVR hiccup — next tick will retry */ }
    } else if (frameBuf.length) frameBuf.length = 0
    setTimeout(tick, CFG.burstIntervalMs)
  }
  tick()
}

// Post the buffered frames around the event (walk-up, drop-off, walk-out) as
// one photo set, threaded under the text alert when its ts is provided.
async function postSlackBurst(eventTs = Date.now(), threadTs = null) {
  const { token, channel } = CFG.slack
  if (!token || !channel) return
  // Wait for the post-roll frames to land in the buffer.
  const windowEnd = eventTs + CFG.burstPostRollMs
  while (Date.now() < windowEnd + CFG.burstIntervalMs) await sleep(500)
  let picked = frameBuf.filter(f => f.ts >= eventTs - CFG.burstPreRollMs && f.ts <= windowEnd)
  // Cap at burstCount, evenly spaced across the window, skipping identical frames.
  if (picked.length > CFG.burstCount) {
    const step = (picked.length - 1) / (CFG.burstCount - 1)
    picked = Array.from({ length: CFG.burstCount }, (_, i) => picked[Math.round(i * step)])
  }
  const frames = []
  for (const f of picked) {
    if (!frames.length || !frames[frames.length - 1].equals(f.jpg)) frames.push(f.jpg)
  }
  if (!frames.length) { warn('burst: no frames buffered around event'); return }
  const ids = []
  for (const [i, jpg] of frames.entries()) {
    const filename = `freight-bay-${Date.now()}-${i + 1}.jpg`
    const up = await slackApi('files.getUploadURLExternal', null, { query: { filename, length: String(jpg.length) } })
    if (!up.ok) throw new Error(`getUploadURLExternal: ${up.error}`)
    const put = await httpsRequest(up.upload_url, { method: 'POST', body: jpg, headers: { 'Content-Type': 'image/jpeg' } })
    if (put.status < 200 || put.status >= 300) throw new Error(`upload POST HTTP ${put.status}`)
    ids.push({ id: up.file_id, title: `Freight bay ${i + 1}/${frames.length}` })
  }
  const payload = { files: ids, channel_id: channel }
  if (threadTs) payload.thread_ts = threadTs
  const done = await slackApi('files.completeUploadExternal', payload)
  if (!done.ok) throw new Error(`completeUploadExternal: ${done.error}`)
  log(`Slack burst posted (${frames.length} frames${threadTs ? ', threaded' : ''})`)
}

async function slackApi(method, jsonBody, { query } = {}) {
  let url = `https://slack.com/api/${method}`
  const headers = { Authorization: `Bearer ${CFG.slack.token}` }
  let body
  if (query) url += '?' + new URLSearchParams(query).toString()
  if (jsonBody) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    body = Buffer.from(JSON.stringify(jsonBody))
  }
  const r = await httpsRequest(url, { method: 'POST', headers, body })
  try { return JSON.parse(r.body.toString('utf8')) }
  catch { return { ok: false, error: `Slack ${method}: non-JSON reply (HTTP ${r.status})` } }
}

// ── Event handler ───────────────────────────────────────────────────────
// Alert on ARRIVAL, not on presence: every detection refreshes the activity
// timer, so someone working in and out of the bay holds the alert closed.
// The next alert fires only for activity after COOLDOWN_MS of quiet.
async function onLineCross(evt) {
  const now = Date.now()
  const quietFor = now - lastFired
  lastFired = now // any matching event counts as activity, alerted or not
  if (!inBusinessHours()) { log(`event ${evt.eventType} ch ${evt.channelId} — outside business hours, ignored`); return }
  if (quietFor < CFG.cooldownMs) { log(`ongoing activity (quiet ${Math.round(quietFor / 1000)}s < ${CFG.cooldownMs / 1000}s) — no new alert`); return }
  log(`FREIGHT BAY ALERT — ${evt.eventType} ch ${evt.channelId}`)
  // Priority order: ring + text alert go out ASAP; the photo burst follows
  // as a thread reply under the alert.
  ringPhone()
  let alertTs = null
  try { alertTs = await postSlackText() } catch (e) { warn('postSlackText:', e.message) }
  try { await postSlackBurst(now, alertTs) }
  catch (e) {
    warn('burst:', e.message, '— falling back to single snapshot')
    try { await postSlack(await snapshot().catch(() => null)) } catch (e2) { warn('postSlack:', e2.message) }
  }
}

// ── Alert stream: long-lived multipart, digest auth, reconnect ────────────
function matchesFreightBay(evt) {
  if (!CFG.eventTypes.includes(String(evt.eventType || '').toLowerCase())) return false
  // Some firmwares report channelID, some dynChannelID; compare loosely.
  const ids = [evt.channelId, evt.dynChannelId].filter(Boolean).map(String)
  // Events carry the bare input number (D24 -> "24") while streaming URIs use
  // <input>01 ("2401") — accept the configured channel in either form.
  const n = parseInt(CFG.nvr.channelId, 10)
  const forms = new Set([String(n), String(Math.floor(n / 100)), `${n}01`])
  return ids.some(id => forms.has(id))
}

function parseEventXml(text) {
  const pick = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'))
    return m ? m[1].trim() : null
  }
  return {
    eventType: pick('eventType'),
    channelId: pick('channelID') || pick('channelId'),
    dynChannelId: pick('dynChannelID'),
    state: pick('eventState'),
  }
}

let streamBuf = Buffer.alloc(0)
function feedStream(chunk, onEvent) {
  streamBuf = Buffer.concat([streamBuf, chunk])
  // Events are XML/JSON documents inside multipart parts. Rather than track the
  // MIME boundary precisely across firmwares, slice on the XML envelope, which
  // is stable: <EventNotificationAlert …> … </EventNotificationAlert>.
  let text = streamBuf.toString('utf8')
  const closeTag = '</EventNotificationAlert>'
  let idx
  while ((idx = text.indexOf(closeTag)) !== -1) {
    const end = idx + closeTag.length
    const openIdx = text.lastIndexOf('<EventNotificationAlert', 0)
    const startSearch = text.slice(0, end)
    const open = startSearch.lastIndexOf('<EventNotificationAlert')
    const doc = open !== -1 ? startSearch.slice(open, end) : startSearch.slice(0, end)
    try {
      const evt = parseEventXml(doc)
      if (evt.eventType) onEvent(evt)
    } catch (e) { /* skip malformed */ }
    text = text.slice(end)
  }
  // Keep only the unconsumed tail (guard against unbounded growth).
  streamBuf = Buffer.from(text, 'utf8')
  if (streamBuf.length > 1_000_000) streamBuf = streamBuf.slice(-100_000)
}

// Extract every EventNotificationAlert envelope from a one-shot body (the
// alarm-server POST delivers a complete document, sometimes multipart with an
// image part — we only scan for the XML envelope so binary parts are ignored).
function handleAlarmBody(body, onEvent) {
  if (body.includes('<EventNotificationAlert')) {
    for (const seg of body.split('</EventNotificationAlert>')) {
      const open = seg.lastIndexOf('<EventNotificationAlert')
      if (open === -1) continue
      const evt = parseEventXml(seg.slice(open) + '</EventNotificationAlert>')
      if (evt.eventType) onEvent(evt)
    }
  } else {
    const evt = parseEventXml(body)
    if (evt.eventType) onEvent(evt)
  }
}

// PUSH model: the camera/NVR Alarm Server (HTTP host) POSTs events here. No
// long-lived connection, so nothing to drop — the reliable path on NVRs whose
// alertStream keeps closing.
function startAlarmServer(onEvent) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); res.end('ja-freightbay ok'); return }
    const chunks = []
    let size = 0
    req.on('data', d => { size += d.length; if (size < 5_000_000) chunks.push(d) })
    req.on('end', () => {
      res.writeHead(200); res.end('ok')
      try { handleAlarmBody(Buffer.concat(chunks).toString('utf8'), onEvent) }
      catch (e) { warn('alarm parse:', e.message) }
    })
    req.on('error', () => { try { res.writeHead(400); res.end() } catch { /* */ } })
  })
  server.on('error', e => warn(`alarm listener error: ${e.message}`))
  server.listen(CFG.listenPort, () => log(`alarm HTTP listener on :${CFG.listenPort} (point the camera's Alarm Server here)`))
  return server
}

function subscribeAlertStream(onEvent) {
  const { host, port, user, pass } = CFG.nvr
  const uri = '/ISAPI/Event/notification/alertStream'
  const connect = () => {
    log(`connecting to alertStream ${host}:${port}${uri}`)
    // Keep the connection open: NVRs close the multipart stream when the
    // client sends the default "Connection: close", so force keep-alive and
    // no connection pooling (agent:false). No socket timeout — the stream is
    // meant to stay open indefinitely between events/heartbeats.
    const streamHeaders = { Connection: 'keep-alive', Accept: 'multipart/mixed, application/xml, */*' }
    // Digest handshake first (401 → challenge), then open the long-lived GET.
    const probe = http.request({ host, port, path: uri, method: 'GET', agent: false, headers: { Connection: 'keep-alive' } }, res1 => {
      if (res1.statusCode !== 401) {
        // Some NVRs allow the stream without a fresh challenge — use directly.
        return attach(res1)
      }
      res1.resume()
      const ch = parseChallenge(res1.headers['www-authenticate'] || '')
      const auth = buildDigestHeader(ch, { method: 'GET', uri, user, pass })
      const streamReq = http.request(
        { host, port, path: uri, method: 'GET', agent: false, headers: { ...streamHeaders, Authorization: auth } },
        attach,
      )
      streamReq.on('error', onErr)
      streamReq.end()
    })
    probe.on('error', onErr)
    probe.end()
  }
  const attach = (res) => {
    if (res.statusCode !== 200) { onErr(new Error(`alertStream HTTP ${res.statusCode}`)); res.resume(); return }
    log('alertStream connected')
    streamBuf = Buffer.alloc(0)
    // Never let a socket idle-timeout kill the stream.
    if (res.socket) res.socket.setTimeout(0)
    res.on('data', d => { try { feedStream(d, onEvent) } catch (e) { warn('parse:', e.message) } })
    res.on('end', () => onErr(new Error('alertStream ended')))
    res.on('error', onErr)
  }
  let reconnecting = false
  const onErr = (e) => {
    if (reconnecting) return
    reconnecting = true
    warn('alertStream:', e.message, `— reconnecting in ${CFG.reconnectMs}ms`)
    setTimeout(() => { reconnecting = false; connect() }, CFG.reconnectMs)
  }
  connect()
}

// ── CLI test helpers + main ────────────────────────────────────────────────
async function main() {
  if (ARGS.has('--test-ring')) { log('test: ringing phone'); ringPhone(); return }
  if (ARGS.has('--test-snapshot')) {
    const jpg = await snapshot(); const out = `/tmp/fb-test-${Date.now()}.jpg`
    fs.writeFileSync(out, jpg); log(`snapshot OK (${jpg.length} bytes) → ${out}`); return
  }
  if (ARGS.has('--test-slack')) {
    const jpg = await snapshot().catch(e => { warn('snapshot:', e.message); return null })
    await postSlack(jpg); log('test-slack done'); return
  }
  if (ARGS.has('--test-burst')) { startFrameBuffer(); const ts = await postSlackText(); await postSlackBurst(Date.now(), ts); log('test-burst done'); process.exit(0) }
  if (ARGS.has('--once')) { await onLineCross({ eventType: 'manual', channelId: CFG.nvr.channelId }); return }

  const probe = ARGS.has('--probe')
  // --listen: only the push listener (skip the pull-stream), for testing the
  // camera's Alarm Server config without the reconnect noise.
  const listenOnly = ARGS.has('--listen')

  // Startup sanity.
  for (const [k, v] of Object.entries({ NVR_USER: CFG.nvr.user, ALERT_EXTENSION: CFG.alertExt, SLACK_BOT_TOKEN: CFG.slack.token, SLACK_CHANNEL_ID: CFG.slack.channel })) {
    if (!v) warn(`${k} is not set`)
  }
  log(`ja-freightbay up — NVR ${CFG.nvr.host} ch ${CFG.nvr.channelId}, ext ${CFG.alertExt || '(none)'}, ` +
      `hours ${CFG.startHhmm}-${CFG.endHhmm} ${CFG.tz} days [${CFG.days}], cooldown ${CFG.cooldownMs}ms`)
  if (probe) log('PROBE MODE — logging every event, taking NO actions')

  // Shared handler for events from EITHER source (stream or push listener).
  const handle = (evt, src) => {
    if (probe) { log(`event [${src}]:`, JSON.stringify(evt)); return }
    if (matchesFreightBay(evt) && String(evt.state || '').toLowerCase() !== 'inactive') {
      onLineCross(evt).catch(e => warn('onLineCross:', e.message))
    }
  }

  if (CFG.useAlarmServer || listenOnly) startAlarmServer(evt => handle(evt, 'push'))
  if (CFG.useAlertStream && !listenOnly) subscribeAlertStream(evt => handle(evt, 'stream'))
  if (!probe) startFrameBuffer()
}

// Only run the service when invoked directly; `require()` (tests) gets the
// internals without starting the stream.
if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1) })
}

module.exports = { buildDigestHeader, parseChallenge, inBusinessHours, parseEventXml, feedStream, handleAlarmBody, matchesFreightBay, CFG }


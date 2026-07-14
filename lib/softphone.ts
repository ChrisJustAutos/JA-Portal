// lib/softphone.ts
// Thin wrapper around SIP.js's UserAgent so the calls page can register a
// browser-side SIP endpoint against FreePBX over WSS, and auto-answer the
// incoming ChanSpy INVITE that the PBX agent triggers when the manager clicks
// "Listen / Whisper / Barge — on Device".
//
// We deliberately do not expose dialling or DTMF — this softphone exists for
// monitoring only. The microphone is muted by default for Listen, unmuted for
// Whisper/Barge (handled by the caller via setMicMuted).
//
// Lifecycle:
//   const sp = new Softphone({ wssUrl, sipDomain, extension, password, audioEl })
//   sp.on('status', s => …)   // 'connecting' | 'registered' | 'failed' | 'unregistered'
//   sp.on('call',   s => …)   // 'incoming' | 'answered' | 'ended'
//   await sp.connect()
//   sp.setMicMuted(true)      // before/after answer
//   sp.hangup()
//   await sp.disconnect()
//
// Notes:
//   • dynamic import of sip.js — keeps the calls page bundle small for users
//     who don't have a softphone configured.
//   • the SDP offer mic constraint is applied per call; for Listen we still
//     publish a (muted) mic track so the SDP completes and the call can later
//     be promoted to Whisper without renegotiation. PBX-side ChanSpy decides
//     whether the manager's audio is mixed in based on the mode it was started
//     with, so muting here is a safety net, not the primary gate.

type StatusEvt = 'connecting' | 'registered' | 'failed' | 'unregistered'
type CallEvt   = 'incoming' | 'answered' | 'ended'

export interface SoftphoneConfig {
  wssUrl: string        // e.g. wss://pbx.example.com:8089/ws
  sipDomain: string     // e.g. pbx.example.com
  extension: string     // SIP user (the WebRTC extension number)
  password: string      // SIP digest auth password
  // Where the remote audio stream attaches. A <video> element (playsinline) is
  // used in practice — WebKit/iOS plays remote WebRTC audio reliably through a
  // video element but is often silent through an <audio> element.
  audioEl: HTMLMediaElement
  // Diagnostic: periodic media stats while in a call. rxBytes growing = audio
  // is actually arriving (so silence is a playback issue); rxBytes stuck at 0 +
  // ice not 'connected' = the media path failed (e.g. needs TURN on mobile).
  onStats?: (s: { ice: string; conn: string; rxBytes: number; rxPackets: number; level: number }) => void
  // ICE servers (STUN + TURN). TURN is required for media to flow on restrictive
  // NAT / mobile carriers. Defaults to a public STUN if omitted.
  iceServers?: RTCIceServer[]
}

type Listener<E> = (evt: E, detail?: any) => void

export class Softphone {
  private ua: any = null
  private registerer: any = null
  private currentSession: any = null
  private statusListeners: Listener<StatusEvt>[] = []
  private callListeners: Listener<CallEvt>[] = []
  private micMuted = true
  private autoAnswerNext = false
  private statsTimer: any = null
  private closing = false
  private reconnectAttempts = 0
  private reconnectTimer: any = null

  constructor(private cfg: SoftphoneConfig) {}

  // Registered (or on a call) and usable right now?
  isReady(): boolean {
    return !!this.ua && this.registerer?.state === 'Registered'
  }

  on(kind: 'status', cb: Listener<StatusEvt>): void
  on(kind: 'call', cb: Listener<CallEvt>): void
  on(kind: 'status' | 'call', cb: any) {
    if (kind === 'status') this.statusListeners.push(cb)
    else this.callListeners.push(cb)
  }

  private emitStatus(s: StatusEvt, detail?: any) {
    for (const cb of this.statusListeners) try { cb(s, detail) } catch {}
  }
  private emitCall(s: CallEvt, detail?: any) {
    for (const cb of this.callListeners) try { cb(s, detail) } catch {}
  }

  // Tell the softphone the next incoming INVITE is one we requested and should
  // auto-answer. Set right before POSTing to /api/calls/live/spy so we don't
  // accidentally auto-answer some other inbound call to this extension.
  expectIncoming() { this.autoAnswerNext = true }

  async connect() {
    if (this.ua) return
    this.emitStatus('connecting')

    // sip.js exposes only ESM. Use dynamic import; the resulting bundle is
    // pulled in on demand.
    const sip = await import('sip.js')
    const { UserAgent, Registerer, Web } = sip as any

    const uri = UserAgent.makeURI(`sip:${this.cfg.extension}@${this.cfg.sipDomain}`)
    if (!uri) throw new Error('Invalid SIP URI')

    this.closing = false
    this.ua = new UserAgent({
      uri,
      // keepAliveInterval: CRLF pings over the WSS every 15s. Without them the
      // socket is DEAD SILENT during a call (media is separate RTP), so NAT /
      // proxy idle timeouts close it — and Asterisk tears down every dialog on
      // a closed WebSocket, which is what dropped monitors mid-call.
      transportOptions: { server: this.cfg.wssUrl, keepAliveInterval: 15 },
      authorizationUsername: this.cfg.extension,
      authorizationPassword: this.cfg.password,
      sessionDescriptionHandlerFactoryOptions: {
        constraints: { audio: true, video: false },
        peerConnectionConfiguration: {
          iceServers: (this.cfg.iceServers && this.cfg.iceServers.length)
            ? this.cfg.iceServers
            : [{ urls: 'stun:stun.l.google.com:19302' }],
        },
      },
      delegate: {
        onInvite: (invitation: any) => this.handleInvite(invitation),
        onDisconnect: () => {
          this.emitStatus('unregistered')
          this.scheduleReconnect()
        },
      },
    })

    try {
      await this.ua.start()
    } catch (e: any) {
      this.emitStatus('failed', { reason: e?.message || 'transport_failed' })
      throw e
    }

    this.registerer = new Registerer(this.ua)
    this.registerer.stateChange.addListener((state: string) => {
      if (state === 'Registered') this.emitStatus('registered')
      else if (state === 'Unregistered') this.emitStatus('unregistered')
    })
    try {
      await this.registerer.register()
    } catch (e: any) {
      this.emitStatus('failed', { reason: e?.message || 'register_failed' })
      throw e
    }
    this.reconnectAttempts = 0

    // Stash a reference to Web for media attachment.
    ;(this as any)._sipWeb = Web
  }

  // The transport dropped without us asking (network blip, PBX restart, proxy
  // idle-kill that slipped past the keepalive). Reconnect with backoff and
  // re-register so the softphone recovers without a page refresh. An in-flight
  // spy call is gone either way (Asterisk destroyed its dialog with the
  // socket), but the next Listen click must Just Work.
  private scheduleReconnect() {
    if (this.closing || this.reconnectTimer || !this.ua) return
    if (this.reconnectAttempts >= 6) {
      this.emitStatus('failed', { reason: 'connection lost — reconnect attempts exhausted' })
      return
    }
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10_000)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.closing || !this.ua) return
      this.reconnectAttempts++
      this.emitStatus('connecting')
      try {
        await this.ua.reconnect()
        await this.registerer?.register()   // listener emits 'registered'
        this.reconnectAttempts = 0
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  setMicMuted(muted: boolean) {
    this.micMuted = muted
    const session = this.currentSession
    if (!session) return
    const pc: RTCPeerConnection | undefined = session.sessionDescriptionHandler?.peerConnection
    if (!pc) return
    for (const sender of pc.getSenders()) {
      if (sender.track && sender.track.kind === 'audio') sender.track.enabled = !muted
    }
  }

  isMicMuted() { return this.micMuted }

  // Poll RTCPeerConnection stats so the UI can show whether audio is actually
  // arriving (diagnoses media-path/TURN problems vs playback problems).
  private startStats() {
    const cb = this.cfg.onStats
    if (!cb) return
    const pc: RTCPeerConnection | undefined = this.currentSession?.sessionDescriptionHandler?.peerConnection
    if (!pc) return
    this.stopStats()
    this.statsTimer = setInterval(async () => {
      try {
        const stats = await pc.getStats()
        let rxBytes = 0, rxPackets = 0, level = 0
        stats.forEach((r: any) => {
          if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) { rxBytes = r.bytesReceived || 0; rxPackets = r.packetsReceived || 0 }
          if (r.type === 'track' && typeof r.audioLevel === 'number') level = r.audioLevel
        })
        cb({ ice: pc.iceConnectionState, conn: pc.connectionState, rxBytes, rxPackets, level })
      } catch {}
    }, 2000)
  }
  private stopStats() { if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null } }

  hangup() {
    this.stopStats()
    const s = this.currentSession
    if (!s) return
    try {
      if (s.state === 'Established') s.bye()
      else if (s.state === 'Initial' || s.state === 'Establishing') s.reject?.()
      else s.dispose?.()
    } catch {}
    this.currentSession = null
  }

  async disconnect() {
    this.closing = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    this.hangup()
    try { await this.registerer?.unregister() } catch {}
    try { await this.ua?.stop() } catch {}
    this.registerer = null
    this.ua = null
  }

  private async handleInvite(invitation: any) {
    // If we weren't expecting a call, reject — protects against random INVITEs
    // hitting this extension while the user is on the calls page.
    if (!this.autoAnswerNext) {
      try { invitation.reject() } catch {}
      return
    }
    this.autoAnswerNext = false

    this.currentSession = invitation
    this.emitCall('incoming')

    // Wire up the remote stream onto our audio element as soon as the SDP is
    // negotiated. sip.js's session description handler exposes the
    // RTCPeerConnection once accept() begins, so attach a one-shot listener.
    invitation.stateChange.addListener((state: string) => {
      if (state === 'Established') { this.attachRemoteAudio(); this.startStats() }
      if (state === 'Terminated') {
        this.stopStats()
        if (this.currentSession === invitation) this.currentSession = null
        this.emitCall('ended')
      }
    })

    try {
      await invitation.accept({
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
      })
      // Apply current mute state immediately so Listen really is silent at our end.
      this.setMicMuted(this.micMuted)
      this.emitCall('answered')
    } catch (e: any) {
      this.emitCall('ended', { error: e?.message })
      this.currentSession = null
    }
  }

  private attachRemoteAudio() {
    const session = this.currentSession
    if (!session) return
    const pc: RTCPeerConnection | undefined = session.sessionDescriptionHandler?.peerConnection
    if (!pc) return
    const stream = new MediaStream()
    for (const receiver of pc.getReceivers()) {
      if (receiver.track && receiver.track.kind === 'audio') stream.addTrack(receiver.track)
    }
    // Plain <audio> element playback. NOTE: do NOT route remote WebRTC streams
    // through the Web Audio API — WebKit (all iOS browsers) only supports
    // createMediaStreamSource for LOCAL streams, so a remote stream there is
    // silent. The element route is what works on iOS Safari.
    const el = this.cfg.audioEl
    el.srcObject = stream
    el.muted = false
    el.volume = 1
    ;(el as any).playsInline = true
    el.setAttribute('playsinline', '')
    // Retry play() a few times — on iOS the track isn't always flowing on the
    // first tick after 'Established'. The "🔊 Tap to hear" button is the
    // guaranteed-gesture fallback if autoplay stays blocked.
    const tryPlay = () => { try { const p = el.play(); if (p && typeof p.catch === 'function') p.catch(() => {}) } catch {} }
    tryPlay()
    setTimeout(tryPlay, 300)
    setTimeout(tryPlay, 1000)
    setTimeout(tryPlay, 2500)
  }
}

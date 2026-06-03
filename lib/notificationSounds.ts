// lib/notificationSounds.ts
// Notification chimes synthesised with the Web Audio API — no audio files to
// ship or load. A few presets the user can pick between; the choice is a
// per-device preference stored in localStorage (different speakers/devices).

export interface SoundOption { id: string; label: string }
export const NOTIFICATION_SOUNDS: SoundOption[] = [
  { id: 'chime',   label: 'Chime' },
  { id: 'ding',    label: 'Ding' },
  { id: 'ping',    label: 'Ping' },
  { id: 'marimba', label: 'Marimba' },
  { id: 'pop',     label: 'Pop' },
  { id: 'none',    label: 'Off (silent)' },
]

const STORAGE_KEY = 'ja-notif-sound'
const DEFAULT = 'chime'

export function getSound(): string {
  if (typeof window === 'undefined') return DEFAULT
  return window.localStorage.getItem(STORAGE_KEY) || DEFAULT
}
export function setSound(id: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, id)
}

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as any).webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  return ctx
}

// Browsers block audio until the user has interacted with the page — call this
// from a user gesture (e.g. first click) so later notification sounds play.
export function primeAudio(): void { audio() }

function blip(c: AudioContext, freq: number, t0: number, dur: number, type: OscillatorType = 'sine', peak = 0.18): void {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(g); g.connect(c.destination)
  osc.start(t0); osc.stop(t0 + dur + 0.03)
}

export function playSound(id?: string): void {
  const which = id || getSound()
  if (which === 'none') return
  const c = audio(); if (!c) return
  const t = c.currentTime + 0.01
  switch (which) {
    case 'ding':    blip(c, 1047, t, 0.5, 'sine'); break
    case 'ping':    blip(c, 1568, t, 0.25, 'triangle', 0.16); break
    case 'pop':     blip(c, 620, t, 0.16, 'square', 0.10); break
    case 'marimba':
      blip(c, 784, t, 0.22, 'sine')
      blip(c, 988, t + 0.10, 0.22, 'sine')
      blip(c, 1319, t + 0.20, 0.32, 'sine')
      break
    case 'chime':
    default:
      blip(c, 880, t, 0.4, 'sine')
      blip(c, 1318.5, t + 0.13, 0.5, 'sine')
      break
  }
}

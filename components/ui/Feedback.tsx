// components/ui/Feedback.tsx
// Portal-wide feedback primitives that replace the browser-native
// confirm()/alert()/prompt() calls (79 instances audited 2026-06-10) and the
// fragmented per-page [msg, setMsg] inline-toast pattern.
//
// FeedbackProvider mounts once in pages/_app.tsx. Pages use the hooks:
//
//   const toast = useToast()
//   toast('Saved')                        // neutral
//   toast('Posted to MYOB', 'success')
//   toast(err.message, 'error')
//
//   const confirmDialog = useConfirm()
//   if (!(await confirmDialog({ title: 'Delete invoice?', message: '…', danger: true }))) return
//
//   const promptDialog = usePrompt()
//   const v = await promptDialog({ title: 'Daily capacity', label: 'Hours', defaultValue: '8' })
//   if (v === null) return   // cancelled
//
// All dialogs support Esc (cancel) + Enter (confirm) and trap initial focus.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { T } from '../../lib/ui/theme'

type ToastKind = 'info' | 'success' | 'error'
interface ToastItem { id: number; msg: string; kind: ToastKind }

interface ConfirmOpts { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface PromptOpts { title: string; label?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; inputMode?: 'text' | 'numeric' | 'decimal' }

interface FeedbackApi {
  toast: (msg: string, kind?: ToastKind) => void
  confirmDialog: (opts: ConfirmOpts) => Promise<boolean>
  promptDialog: (opts: PromptOpts) => Promise<string | null>
}

const Ctx = createContext<FeedbackApi | null>(null)

export function useToast(): FeedbackApi['toast'] {
  const api = useContext(Ctx)
  return api ? api.toast : (msg: string) => { if (typeof window !== 'undefined') window.alert(msg) }
}
export function useConfirm(): FeedbackApi['confirmDialog'] {
  const api = useContext(Ctx)
  return api ? api.confirmDialog : async (o: ConfirmOpts) => (typeof window !== 'undefined' ? window.confirm(o.title) : false)
}
export function usePrompt(): FeedbackApi['promptDialog'] {
  const api = useContext(Ctx)
  return api ? api.promptDialog : async (o: PromptOpts) => (typeof window !== 'undefined' ? window.prompt(o.title, o.defaultValue || '') : null)
}

const KIND_COLOR: Record<ToastKind, string> = { info: T.blue, success: T.green, error: T.red }

let toastSeq = 1

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [confirm, setConfirm] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)
  const [prompt, setPrompt] = useState<(PromptOpts & { resolve: (v: string | null) => void; value: string }) | null>(null)

  const toast = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = toastSeq++
    setToasts(ts => [...ts.slice(-3), { id, msg, kind }])
    setTimeout(() => setToasts(ts => ts.filter(t => t.id !== id)), kind === 'error' ? 7000 : 4000)
  }, [])

  const confirmDialog = useCallback((opts: ConfirmOpts) => new Promise<boolean>(resolve => {
    setConfirm({ ...opts, resolve })
  }), [])

  const promptDialog = useCallback((opts: PromptOpts) => new Promise<string | null>(resolve => {
    setPrompt({ ...opts, resolve, value: opts.defaultValue ?? '' })
  }), [])

  const closeConfirm = (v: boolean) => { confirm?.resolve(v); setConfirm(null) }
  const closePrompt = (v: string | null) => { prompt?.resolve(v); setPrompt(null) }

  return (
    <Ctx.Provider value={{ toast, confirmDialog, promptDialog }}>
      {children}

      {/* Toast stack — bottom-right, above everything */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', right: 16, bottom: 'calc(16px + var(--safe-bottom, 0px))', zIndex: 10000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380 }}>
          {toasts.map(t => (
            <div key={t.id} role="status" onClick={() => setToasts(ts => ts.filter(x => x.id !== t.id))} style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.45, cursor: 'pointer',
              background: T.bg3, color: T.text, border: `1px solid ${KIND_COLOR[t.kind]}55`,
              borderLeft: `3px solid ${KIND_COLOR[t.kind]}`, boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
              fontFamily: "'DM Sans',system-ui,sans-serif",
            }}>{t.msg}</div>
          ))}
        </div>
      )}

      {confirm && (
        <Modal onCancel={() => closeConfirm(false)}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: confirm.message ? 8 : 16 }}>{confirm.title}</div>
          {confirm.message && <div style={{ fontSize: 12, color: T.text2, lineHeight: 1.55, marginBottom: 16, whiteSpace: 'pre-wrap' }}>{confirm.message}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <DlgBtn onClick={() => closeConfirm(false)}>{confirm.cancelLabel || 'Cancel'}</DlgBtn>
            <DlgBtn primary danger={confirm.danger} autoFocus onClick={() => closeConfirm(true)}>{confirm.confirmLabel || 'Confirm'}</DlgBtn>
          </div>
        </Modal>
      )}

      {prompt && (
        <Modal onCancel={() => closePrompt(null)}>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 12 }}>{prompt.title}</div>
          {prompt.label && <div style={{ fontSize: 11, color: T.text3, marginBottom: 6 }}>{prompt.label}</div>}
          <input
            autoFocus
            value={prompt.value}
            inputMode={prompt.inputMode || 'text'}
            placeholder={prompt.placeholder}
            onChange={e => setPrompt(p => p && { ...p, value: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') closePrompt(prompt.value) }}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '9px 12px', marginBottom: 16,
              background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6,
              color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <DlgBtn onClick={() => closePrompt(null)}>Cancel</DlgBtn>
            <DlgBtn primary onClick={() => closePrompt(prompt.value)}>{prompt.confirmLabel || 'Save'}</DlgBtn>
          </div>
        </Modal>
      )}
    </Ctx.Provider>
  )
}

// ── internals ───────────────────────────────────────────────────────────

function Modal({ children, onCancel }: { children: React.ReactNode; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div role="dialog" aria-modal="true"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)', padding: 16, fontFamily: "'DM Sans',system-ui,sans-serif",
      }}>
      <div ref={ref} style={{
        width: '100%', maxWidth: 420, background: T.bg3, border: `1px solid ${T.border2}`,
        borderRadius: 10, padding: '18px 20px', boxShadow: '0 12px 48px rgba(0,0,0,0.6)',
      }}>
        {children}
      </div>
    </div>
  )
}

function DlgBtn({ children, onClick, primary, danger, autoFocus }: {
  children: React.ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; autoFocus?: boolean
}) {
  const c = danger ? T.red : T.blue
  return (
    <button autoFocus={autoFocus} onClick={onClick} style={{
      padding: '8px 16px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer',
      background: primary ? `${c}1e` : 'transparent',
      color: primary ? c : T.text2,
      border: `1px solid ${primary ? c + '55' : T.border2}`,
    }}>{children}</button>
  )
}

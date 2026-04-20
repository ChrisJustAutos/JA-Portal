// components/GlobalChatbot.tsx
// Floating AI assistant, mounted globally via _app.tsx on every portal page.
//
// Features:
//   - Floating button bottom-right that expands to a ~400px wide chat panel
//   - Persistent chat history across pages and sessions (stored in Supabase)
//   - Session list dropdown ("Recent") to switch between conversations
//   - "New chat" button to start fresh
//   - Auto-detects current portal page and passes as context to the LLM
//   - Optional page-specific context via setChatContext() from useChatContext()
//
// Wiring:
//   - _app.tsx mounts <GlobalChatbot /> alongside <Component>
//   - Pages optionally call useChatContext().setContext({...}) to pass extra data
//
// Hidden on /login and /reset-password where user isn't authed yet.

import { useState, useEffect, useRef, useCallback, createContext, useContext, ReactNode } from 'react'
import { useRouter } from 'next/router'

const T = {
  bg:'#0d0f12', bg2:'#131519', bg3:'#1a1d23', bg4:'#21252d',
  border:'rgba(255,255,255,0.07)', border2:'rgba(255,255,255,0.12)',
  text:'#e8eaf0', text2:'#8b90a0', text3:'#545968',
  blue:'#4f8ef7', teal:'#2dd4bf', green:'#34c77b',
  amber:'#f5a623', red:'#f04e4e', purple:'#a78bfa',
  accent:'#4f8ef7',
}

// ── Types ──────────────────────────────────────────────────────────────

export interface ChatSession {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id?: string
  role: 'user' | 'assistant'
  content: string
  context_page?: string | null
  created_at?: string
  pending?: boolean  // local-only while waiting for assistant reply
}

// ── Context for per-page data injection ────────────────────────────────
// Pages can call useChatContext().setContext({ ... }) to inject structured
// data about the current view into the assistant's system prompt.

interface ChatContextValue {
  pageContext: any
  setPageContext: (ctx: any) => void
}

const ChatContext = createContext<ChatContextValue>({
  pageContext: null,
  setPageContext: () => {},
})

export function ChatContextProvider({ children }: { children: ReactNode }) {
  const [pageContext, setPageContext] = useState<any>(null)
  return (
    <ChatContext.Provider value={{ pageContext, setPageContext }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChatContext() {
  return useContext(ChatContext)
}

// ── Pages where the chat is hidden ─────────────────────────────────────
const HIDDEN_ROUTES = ['/login', '/reset-password']

// ── Main component ─────────────────────────────────────────────────────

export default function GlobalChatbot() {
  const router = useRouter()
  const { pageContext } = useChatContext()
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [showSessionsList, setShowSessionsList] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll messages to bottom when new ones arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, sending])

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 200)
    }
  }, [open])

  // Load session list when chat first opens
  useEffect(() => {
    if (!open) return
    fetch('/api/chat-sessions')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setSessions(data.sessions || []))
      .catch(() => { /* silent — empty list is fine */ })
  }, [open])

  // When activeSessionId changes, load its messages
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      return
    }
    setLoadingMessages(true)
    fetch(`/api/chat-sessions/${activeSessionId}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setMessages(data.messages || []))
      .catch(() => setError('Could not load conversation'))
      .finally(() => setLoadingMessages(false))
  }, [activeSessionId])

  const startNewChat = useCallback(() => {
    setActiveSessionId(null)
    setMessages([])
    setShowSessionsList(false)
    setError(null)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const pickSession = useCallback((s: ChatSession) => {
    setActiveSessionId(s.id)
    setShowSessionsList(false)
  }, [])

  const deleteSession = useCallback(async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this conversation? This cannot be undone.')) return
    try {
      const r = await fetch(`/api/chat-sessions/${sessionId}`, { method: 'DELETE' })
      if (!r.ok) throw new Error('Delete failed')
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      if (activeSessionId === sessionId) {
        setActiveSessionId(null)
        setMessages([])
      }
    } catch {
      setError('Could not delete conversation')
    }
  }, [activeSessionId])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    setError(null)
    setSending(true)
    setInput('')

    // Optimistic UI: immediately show user's message + pending assistant bubble
    const optimisticUser: ChatMessage = { role: 'user', content: text }
    const optimisticAssistant: ChatMessage = { role: 'assistant', content: '', pending: true }
    setMessages(prev => [...prev, optimisticUser, optimisticAssistant])

    try {
      const res = await fetch('/api/chat-sessions/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: activeSessionId,
          message: text,
          contextPage: router.pathname,
          contextData: pageContext,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.error || 'Request failed')
      }
      const data = await res.json()

      // Replace optimistic messages with real ones from the server
      setMessages(prev => {
        const withoutPending = prev.filter(m => !m.pending)
        // Replace last user msg with server's copy (has id), append assistant
        const lastUserIdx = withoutPending.length - 1
        const updated = [...withoutPending]
        if (lastUserIdx >= 0 && updated[lastUserIdx].role === 'user') {
          updated[lastUserIdx] = data.userMessage
        }
        updated.push(data.assistantMessage)
        return updated
      })

      // If a new session was created, update local state + add to sessions list
      if (data.sessionCreated && data.session) {
        setActiveSessionId(data.session.id)
        setSessions(prev => [data.session, ...prev])
      } else if (data.session) {
        // Update session in list (its updated_at / title may have changed)
        setSessions(prev => {
          const others = prev.filter(s => s.id !== data.session.id)
          return [data.session, ...others]
        })
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to send')
      // Remove pending/optimistic messages on error
      setMessages(prev => prev.filter(m => !m.pending && m !== optimisticUser))
      setInput(text)  // restore the input so user doesn't lose their typing
    } finally {
      setSending(false)
    }
  }, [input, sending, activeSessionId, router.pathname, pageContext])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage])

  // Hide on login / reset-password pages
  if (HIDDEN_ROUTES.includes(router.pathname)) return null

  return (
    <>
      {/* Floating button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open AI assistant"
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 1000,
            width: 52, height: 52, borderRadius: '50%',
            background: `linear-gradient(135deg, ${T.blue}, ${T.purple})`,
            border: 'none', cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(79, 142, 247, 0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: 22,
            transition: 'transform 0.15s ease',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.05)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.0)' }}
        >
          ✦
        </button>
      )}

      {/* Panel */}
      {open && (
        <div
          role="dialog"
          aria-label="AI Assistant"
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 1000,
            width: 420, maxWidth: 'calc(100vw - 40px)',
            height: 620, maxHeight: 'calc(100vh - 40px)',
            background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 14,
            boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            fontFamily: "'DM Sans', system-ui, sans-serif",
          }}
        >
          {/* Header */}
          <div style={{
            padding: '12px 14px', borderBottom: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: 10,
            background: T.bg3,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: `linear-gradient(135deg, ${T.blue}, ${T.purple})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 14, flexShrink: 0,
            }}>✦</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>JA Assistant</div>
              <div style={{ fontSize: 10, color: T.text3 }}>
                {activeSessionId && sessions.find(s => s.id === activeSessionId)?.title || 'New conversation'}
              </div>
            </div>
            <button
              onClick={() => setShowSessionsList(v => !v)}
              title="Recent conversations"
              style={{
                width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.border}`,
                background: showSessionsList ? T.bg4 : 'transparent',
                color: T.text2, cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ☰
            </button>
            <button
              onClick={startNewChat}
              title="New conversation"
              style={{
                width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.border}`,
                background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              +
            </button>
            <button
              onClick={() => setOpen(false)}
              title="Close"
              style={{
                width: 30, height: 30, borderRadius: 6, border: `1px solid ${T.border}`,
                background: 'transparent', color: T.text3, cursor: 'pointer', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              ✕
            </button>
          </div>

          {/* Sessions list dropdown */}
          {showSessionsList && (
            <div style={{
              maxHeight: 240, overflowY: 'auto',
              borderBottom: `1px solid ${T.border}`,
              background: T.bg3,
            }}>
              {sessions.length === 0 && (
                <div style={{ padding: 14, fontSize: 11, color: T.text3, textAlign: 'center' }}>
                  No previous conversations yet
                </div>
              )}
              {sessions.map(s => (
                <div
                  key={s.id}
                  onClick={() => pickSession(s)}
                  style={{
                    padding: '10px 14px', cursor: 'pointer',
                    borderBottom: `1px solid ${T.border}`,
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: activeSessionId === s.id ? T.bg4 : 'transparent',
                  }}
                  onMouseEnter={e => {
                    if (activeSessionId !== s.id)
                      (e.currentTarget as HTMLDivElement).style.background = T.bg4
                  }}
                  onMouseLeave={e => {
                    if (activeSessionId !== s.id)
                      (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, color: T.text,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{s.title}</div>
                    <div style={{ fontSize: 10, color: T.text3 }}>
                      {new Date(s.updated_at).toLocaleDateString('en-AU', {
                        day: '2-digit', month: 'short',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </div>
                  </div>
                  <button
                    onClick={(e) => deleteSession(s.id, e)}
                    title="Delete"
                    style={{
                      width: 22, height: 22, borderRadius: 4, border: 'none',
                      background: 'transparent', color: T.text3, cursor: 'pointer', fontSize: 11,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = T.red }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = T.text3 }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1, overflowY: 'auto', padding: 14,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}
          >
            {loadingMessages && (
              <div style={{ color: T.text3, fontSize: 12, textAlign: 'center', padding: 20 }}>
                Loading…
              </div>
            )}

            {!loadingMessages && messages.length === 0 && (
              <div style={{ color: T.text3, fontSize: 12, padding: 20, lineHeight: 1.6 }}>
                <div style={{ color: T.text2, fontSize: 13, marginBottom: 10 }}>
                  ✦ Ready to help.
                </div>
                Ask about revenue, open invoices, top customers, stock levels, distributor performance, or anything else about your JAWS + VPS operations.
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    'What are JAWS top 5 customers this month?',
                    'How is VPS tracking vs last month?',
                    'Which stock items need reordering?',
                  ].map(chip => (
                    <button
                      key={chip}
                      onClick={() => { setInput(chip); setTimeout(() => inputRef.current?.focus(), 50) }}
                      style={{
                        textAlign: 'left', background: T.bg3, border: `1px solid ${T.border}`,
                        borderRadius: 6, padding: '8px 10px', fontSize: 11, color: T.text2,
                        cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <MessageBubble key={m.id || i} message={m} />
            ))}
          </div>

          {/* Error */}
          {error && (
            <div style={{
              padding: '8px 14px', fontSize: 11, color: T.red,
              background: `${T.red}10`, borderTop: `1px solid ${T.red}30`,
            }}>
              {error}
            </div>
          )}

          {/* Input */}
          <div style={{
            padding: 12, borderTop: `1px solid ${T.border}`,
            background: T.bg3,
            display: 'flex', gap: 8, alignItems: 'flex-end',
          }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={sending ? 'Waiting for reply…' : 'Ask anything…'}
              disabled={sending}
              rows={1}
              style={{
                flex: 1, background: T.bg2, border: `1px solid ${T.border2}`,
                color: T.text, borderRadius: 8, padding: '9px 11px',
                fontSize: 12.5, outline: 'none', resize: 'none',
                fontFamily: 'inherit', minHeight: 36, maxHeight: 120,
                lineHeight: 1.4,
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending}
              style={{
                padding: '9px 14px', borderRadius: 8, border: 'none',
                background: input.trim() && !sending ? T.blue : T.bg4,
                color: input.trim() && !sending ? '#fff' : T.text3,
                cursor: input.trim() && !sending ? 'pointer' : 'not-allowed',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                minWidth: 56,
              }}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

// ── Message bubble sub-component ───────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div style={{
      display: 'flex',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '88%',
    }}>
      <div style={{
        background: isUser ? T.blue : T.bg3,
        color: isUser ? '#fff' : T.text,
        borderRadius: 10,
        borderBottomRightRadius: isUser ? 3 : 10,
        borderBottomLeftRadius: isUser ? 10 : 3,
        padding: '8px 12px',
        fontSize: 12.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        border: !isUser ? `1px solid ${T.border}` : 'none',
      }}>
        {message.pending ? (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.text3, animation: 'jaDot 1.4s infinite both' }}/>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.text3, animation: 'jaDot 1.4s infinite 0.2s both' }}/>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.text3, animation: 'jaDot 1.4s infinite 0.4s both' }}/>
            <style>{`@keyframes jaDot { 0%,80%,100% { opacity: 0.2 } 40% { opacity: 1 } }`}</style>
          </span>
        ) : (
          message.content
        )}
      </div>
    </div>
  )
}


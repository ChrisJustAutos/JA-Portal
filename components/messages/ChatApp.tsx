// components/messages/ChatApp.tsx
// The realtime chat experience: conversation sidebar (channels + DMs), message
// thread, composer with @mentions + attachments, typing indicators, unread
// counts. Reads live via Supabase Realtime (lib/realtime.ts); writes via the
// /api/conversations + /api/messages routes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSupabase } from '../../lib/supabaseClient'
import { subscribeToConversation, subscribeToConversationList, joinTyping, type TypingChannel } from '../../lib/realtime'
import type { UserRole } from '../../lib/permissions'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}

interface SSRUser { id: string; email: string; displayName: string | null; role: UserRole }
interface Conversation {
  id: string; type: 'channel' | 'dm' | 'group' | 'customer'; name: string | null; displayName: string | null
  topic: string | null; is_private: boolean; source: string | null; status: string
  last_message_at: string | null; isMember: boolean; muted: boolean; unread: number; memberIds: string[]; memberNames: string[]
}
interface Message {
  id: string; conversation_id: string; sender_user_id: string | null; senderName: string; body: string
  message_type: string; created_at: string; edited_at?: string | null; deleted_at?: string | null
  attachments: { id?: string; storage_path: string; filename: string | null; content_type: string | null; size_bytes: number | null }[]
  mentions: string[]
}
interface DirUser { id: string; name: string; email: string; role: string }

const ATTACH_BUCKET = 'chat-attachments'

export default function ChatApp({ user, onUnreadChange }: { user: SSRUser; onUnreadChange?: (n: number) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [dir, setDir] = useState<DirUser[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [modal, setModal] = useState<null | 'channel' | 'dm'>(null)
  const [typers, setTypers] = useState<{ id: string; name: string }[]>([])

  const active = useMemo(() => conversations.find(c => c.id === activeId) || null, [conversations, activeId])
  const totalUnread = useMemo(() => conversations.reduce((s, c) => s + (c.muted ? 0 : c.unread), 0), [conversations])
  useEffect(() => { onUnreadChange?.(totalUnread) }, [totalUnread, onUnreadChange])

  // ── Data loaders ──────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const r = await fetch('/api/conversations')
    if (r.ok) { const d = await r.json(); setConversations(d.conversations || []) }
    setLoadingConvs(false)
  }, [])

  const loadMessages = useCallback(async (conversationId: string, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoadingMsgs(true)
    const r = await fetch(`/api/messages?conversationId=${conversationId}`)
    if (r.ok) { const d = await r.json(); setMessages(d.messages || []) }
    setLoadingMsgs(false)
  }, [])

  const markRead = useCallback(async (conversationId: string) => {
    setConversations(cs => cs.map(c => c.id === conversationId ? { ...c, unread: 0 } : c))
    await fetch(`/api/conversations/${conversationId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read' }) }).catch(() => {})
  }, [])

  useEffect(() => { loadConversations(); fetch('/api/messages/directory').then(r => r.ok ? r.json() : { users: [] }).then(d => setDir(d.users || [])) }, [loadConversations])

  // Live conversation-list updates (new convo, reorder, read state).
  useEffect(() => {
    let t: any
    const debounced = () => { clearTimeout(t); t = setTimeout(loadConversations, 250) }
    const off = subscribeToConversationList(debounced)
    return () => { clearTimeout(t); off() }
  }, [loadConversations])

  // ── Open a conversation: load history, mark read, subscribe live ──
  useEffect(() => {
    if (!activeId) return
    loadMessages(activeId)
    markRead(activeId)
    let t: any
    const reload = () => { clearTimeout(t); t = setTimeout(() => { loadMessages(activeId, { quiet: true }); markRead(activeId) }, 150) }
    const off = subscribeToConversation(activeId, { onMessageInsert: reload, onMessageUpdate: reload })
    return () => { clearTimeout(t); off() }
  }, [activeId, loadMessages, markRead])

  // Typing indicator channel for the active conversation.
  const typingRef = useRef<TypingChannel | null>(null)
  useEffect(() => {
    setTypers([])
    if (!activeId) return
    const ch = joinTyping(activeId, { id: user.id, name: user.displayName || user.email }, setTypers)
    typingRef.current = ch
    return () => { ch.leave(); typingRef.current = null }
  }, [activeId, user.id, user.displayName, user.email])

  // ── Send ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (body: string, mentionIds: string[], attachments: any[]) => {
    if (!activeId) return
    const r = await fetch('/api/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: activeId, body, mentionIds, attachments }),
    })
    if (r.ok) { const d = await r.json(); if (d.message) setMessages(m => m.some(x => x.id === d.message.id) ? m : [...m, d.message]) }
    else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not send') }
  }, [activeId])

  // ── Create conversation ───────────────────────────────────────────
  const createConversation = useCallback(async (payload: any) => {
    const r = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (r.ok) { const d = await r.json(); await loadConversations(); setActiveId(d.conversationId); setModal(null) }
    else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not create') }
  }, [loadConversations])

  const channels = conversations.filter(c => c.type === 'channel' || c.type === 'group')
  const dms = conversations.filter(c => c.type === 'dm')
  const inbox = conversations.filter(c => c.type === 'customer')

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: T.bg }}>
      {/* Sidebar */}
      <div style={{ width: 270, flexShrink: 0, background: T.bg2, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Messages</span>
          {totalUnread > 0 && <span style={{ fontSize: 11, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '1px 7px' }}>{totalUnread}</span>}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {loadingConvs ? <div style={{ padding: 20, color: T.text3, fontSize: 12 }}>Loading…</div> : (
            <>
              <SidebarSection title="Channels" onAdd={() => setModal('channel')}>
                {channels.length === 0 && <Hint>No channels yet</Hint>}
                {channels.map(c => <ConvRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
              </SidebarSection>
              <SidebarSection title="Direct messages" onAdd={() => setModal('dm')}>
                {dms.length === 0 && <Hint>No direct messages</Hint>}
                {dms.map(c => <ConvRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
              </SidebarSection>
              {inbox.length > 0 && (
                <SidebarSection title="Customer inbox">
                  {inbox.map(c => <ConvRow key={c.id} c={c} active={c.id === activeId} onClick={() => setActiveId(c.id)} />)}
                </SidebarSection>
              )}
            </>
          )}
        </div>
      </div>

      {/* Thread */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!active ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 13 }}>
            Select a conversation, or start a new one.
          </div>
        ) : (
          <>
            <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 8 }}>
              <span style={{ color: T.text3 }}>{convGlyph(active)}</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{convTitle(active)}</span>
              {active.topic && <span style={{ fontSize: 12, color: T.text3, marginLeft: 8, borderLeft: `1px solid ${T.border}`, paddingLeft: 8 }}>{active.topic}</span>}
              {active.type !== 'dm' && <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text3 }}>{active.memberIds.length} member{active.memberIds.length === 1 ? '' : 's'}</span>}
            </div>
            <MessageList messages={messages} loading={loadingMsgs} meId={user.id} dir={dir} />
            {typers.length > 0 && (
              <div style={{ padding: '2px 18px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>
                {typers.map(t => t.name).join(', ')} {typers.length === 1 ? 'is' : 'are'} typing…
              </div>
            )}
            <Composer
              conversationId={active.id}
              dir={dir.filter(u => u.id !== user.id)}
              onSend={sendMessage}
              onTyping={() => typingRef.current?.setTyping(true)}
            />
          </>
        )}
      </div>

      {modal && <NewConversationModal kind={modal} dir={dir.filter(u => u.id !== user.id)} onClose={() => setModal(null)} onCreate={createConversation} />}
    </div>
  )
}

// ── Sidebar pieces ───────────────────────────────────────────────────
function SidebarSection({ title, onAdd, children }: { title: string; onAdd?: () => void; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 16px' }}>
        <span style={{ fontSize: 10, color: T.text3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{title}</span>
        {onAdd && <button onClick={onAdd} title={`New ${title}`} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>+</button>}
      </div>
      {children}
    </div>
  )
}
function Hint({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: '4px 16px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{children}</div>
}
function convGlyph(c: Conversation) { return c.type === 'dm' ? '@' : c.type === 'customer' ? '☎' : c.is_private || c.type === 'group' ? '🔒' : '#' }
function convTitle(c: Conversation) { return c.displayName || c.name || (c.type === 'dm' ? 'Direct message' : 'Untitled') }
function ConvRow({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
      padding: '6px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
      background: active ? 'rgba(79,142,247,0.12)' : 'transparent', color: active ? T.text : (c.unread ? T.text : T.text2),
    }}>
      <span style={{ color: T.text3, width: 12, textAlign: 'center', fontSize: 12 }}>{convGlyph(c)}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: c.unread ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{convTitle(c)}</span>
      {c.unread > 0 && <span style={{ fontSize: 10, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '0 6px' }}>{c.unread}</span>}
    </button>
  )
}

// ── Message list ─────────────────────────────────────────────────────
function MessageList({ messages, loading, meId, dir }: { messages: Message[]; loading: boolean; meId: string; dir: DirUser[] }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [messages])
  const nameById = useMemo(() => Object.fromEntries(dir.map(u => [u.id, u.name])), [dir])
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 12 }}>Loading messages…</div>
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {messages.length === 0 && <div style={{ color: T.text3, fontSize: 12, textAlign: 'center', marginTop: 30 }}>No messages yet — say hello.</div>}
      {messages.map(m => {
        const mine = m.sender_user_id === meId
        return (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
            <div style={{ fontSize: 10, color: T.text3, marginBottom: 3 }}>
              <span style={{ color: mine ? T.blue : T.teal, fontWeight: 600 }}>{mine ? 'You' : m.senderName}</span>
              <span style={{ marginLeft: 6 }}>{new Date(m.created_at).toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
            </div>
            <div style={{ maxWidth: '70%', background: mine ? 'rgba(79,142,247,0.16)' : T.bg3, border: `1px solid ${mine ? 'rgba(79,142,247,0.3)' : T.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.5, color: T.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.deleted_at ? <span style={{ color: T.text3, fontStyle: 'italic' }}>message deleted</span> : <MessageBody body={m.body} nameById={nameById} />}
              {m.attachments?.map((a, i) => <AttachmentView key={a.id || i} att={a} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// Highlight @Name mentions.
function MessageBody({ body, nameById }: { body: string; nameById: Record<string, string> }) {
  const names = new Set(Object.values(nameById))
  const parts = body.split(/(@[\w' .-]+)/g)
  return <>{parts.map((p, i) => {
    if (p.startsWith('@') && Array.from(names).some(n => p.slice(1).startsWith(n))) {
      return <span key={i} style={{ color: T.blue, background: 'rgba(79,142,247,0.12)', borderRadius: 3, padding: '0 2px' }}>{p}</span>
    }
    return <span key={i}>{p}</span>
  })}</>
}

function AttachmentView({ att }: { att: { storage_path: string; filename: string | null; content_type: string | null } }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    getSupabase().storage.from(ATTACH_BUCKET).createSignedUrl(att.storage_path, 3600).then(({ data }) => { if (live && data?.signedUrl) setUrl(data.signedUrl) })
    return () => { live = false }
  }, [att.storage_path])
  const isImage = (att.content_type || '').startsWith('image/')
  if (!url) return <div style={{ marginTop: 6, fontSize: 11, color: T.text3 }}>📎 {att.filename || 'attachment'}</div>
  if (isImage) return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={att.filename || ''} style={{ marginTop: 6, maxWidth: 280, maxHeight: 240, borderRadius: 6, display: 'block' }} /></a>
  return <a href={url} target="_blank" rel="noreferrer" style={{ marginTop: 6, display: 'inline-block', fontSize: 12, color: T.blue }}>📎 {att.filename || 'Download attachment'}</a>
}

// ── Composer ─────────────────────────────────────────────────────────
function Composer({ conversationId, dir, onSend, onTyping }: { conversationId: string; dir: DirUser[]; onSend: (body: string, mentionIds: string[], attachments: any[]) => Promise<void>; onTyping: () => void }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [mentionPick, setMentionPick] = useState<{ query: string } | null>(null)
  const [picked, setPicked] = useState<DirUser[]>([])  // users mentioned so far
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => { setText(''); setFiles([]); setPicked([]); setMentionPick(null) }, [conversationId])

  const lastTyping = useRef(0)
  function onChange(v: string) {
    setText(v)
    const now = Date.now(); if (now - lastTyping.current > 1500) { lastTyping.current = now; onTyping() }
    const m = v.match(/@([\w' .-]*)$/)
    setMentionPick(m ? { query: m[1].toLowerCase() } : null)
  }
  function pickMention(u: DirUser) {
    setText(t => t.replace(/@([\w' .-]*)$/, `@${u.name} `))
    setPicked(p => p.some(x => x.id === u.id) ? p : [...p, u])
    setMentionPick(null)
    taRef.current?.focus()
  }
  async function doSend() {
    const body = text.trim()
    if ((!body && files.length === 0) || busy) return
    setBusy(true)
    try {
      // Upload attachments to private bucket.
      const sb = getSupabase()
      const attachments: any[] = []
      for (const f of files) {
        const path = `${conversationId}/${crypto.randomUUID()}-${f.name.replace(/[^\w.-]/g, '_')}`
        const { error } = await sb.storage.from(ATTACH_BUCKET).upload(path, f, { contentType: f.type, upsert: false })
        if (!error) attachments.push({ storagePath: path, filename: f.name, contentType: f.type, sizeBytes: f.size })
      }
      const mentionIds = picked.filter(u => body.includes(`@${u.name}`)).map(u => u.id)
      await onSend(body, mentionIds, attachments)
      setText(''); setFiles([]); setPicked([])
    } finally { setBusy(false) }
  }
  const matches = mentionPick ? dir.filter(u => u.name.toLowerCase().includes(mentionPick.query)).slice(0, 6) : []

  return (
    <div style={{ flexShrink: 0, borderTop: `1px solid ${T.border}`, padding: 12, position: 'relative' }}>
      {matches.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 12, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 8, marginBottom: 6, minWidth: 200, overflow: 'hidden', zIndex: 5 }}>
          {matches.map(u => (
            <div key={u.id} onMouseDown={e => { e.preventDefault(); pickMention(u) }} style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: T.text }}>@{u.name}</div>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {files.map((f, i) => (
            <span key={i} style={{ fontSize: 11, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: '3px 8px', color: T.text2 }}>
              📎 {f.name} <button onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer' }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <label style={{ cursor: 'pointer', color: T.text3, fontSize: 18, padding: '6px 4px' }} title="Attach files">
          📎<input type="file" multiple style={{ display: 'none' }} onChange={e => { setFiles(fs => [...fs, ...Array.from(e.target.files || [])]); e.target.value = '' }} />
        </label>
        <textarea
          ref={taRef}
          value={text}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } }}
          placeholder="Write a message…  (@ to mention, Enter to send)"
          rows={1}
          style={{ flex: 1, resize: 'none', maxHeight: 140, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: 'inherit', padding: '9px 12px', outline: 'none', lineHeight: 1.5 }}
        />
        <button onClick={doSend} disabled={busy} style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: busy ? T.bg4 : T.blue, color: busy ? T.text3 : '#fff', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// ── New conversation modal ───────────────────────────────────────────
function NewConversationModal({ kind, dir, onClose, onCreate }: { kind: 'channel' | 'dm'; dir: DirUser[]; onClose: () => void; onCreate: (payload: any) => void }) {
  const [name, setName] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [q, setQ] = useState('')
  const filtered = dir.filter(u => u.name.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  function submit() {
    if (kind === 'channel') { if (!name.trim()) return; onCreate({ type: 'channel', name, isPrivate, memberIds: selected }) }
    else { if (selected.length === 0) return; if (selected.length === 1) onCreate({ type: 'dm', dmUserId: selected[0] }); else onCreate({ type: 'group', name: name.trim() || null, memberIds: selected }) }
  }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 12, padding: 20, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{kind === 'channel' ? 'New channel' : 'New direct message'}</div>
        {kind === 'channel' && (
          <>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Channel name (e.g. parts-team)" style={inp} autoFocus />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: T.text2, margin: '10px 0 14px', cursor: 'pointer' }}>
              <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} /> Private (invite-only)
            </label>
          </>
        )}
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={kind === 'channel' ? 'Add members…' : 'Search people…'} style={{ ...inp, marginBottom: 8 }} autoFocus={kind === 'dm'} />
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${T.border}`, borderRadius: 8, maxHeight: 260 }}>
          {filtered.length === 0 && <div style={{ padding: 14, fontSize: 12, color: T.text3 }}>No matches.</div>}
          {filtered.map(u => (
            <label key={u.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: `1px solid ${T.border}` }}>
              <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
              <span style={{ color: T.text }}>{u.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: T.text3 }}>{u.role}</span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 6, border: `1px solid ${T.border2}`, background: 'transparent', color: T.text2, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={submit} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: T.blue, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
            {kind === 'channel' ? 'Create channel' : selected.length > 1 ? 'Create group' : 'Start DM'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inp: React.CSSProperties = { width: '100%', padding: '8px 11px', background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 7, color: T.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }

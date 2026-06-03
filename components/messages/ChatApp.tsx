// components/messages/ChatApp.tsx
// Realtime chat experience. Phase 1: channels/DMs, live thread, composer with
// @mentions + attachments, typing, unread. Phase 2 (Slack parity): emoji
// reactions, edit/delete, threaded replies, message search, markdown rendering,
// and desktop notifications. Reads live via Supabase Realtime (lib/realtime.ts);
// writes via /api/conversations + /api/messages.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSupabase } from '../../lib/supabaseClient'
import { subscribeToConversation, subscribeToConversationList, subscribeToAllMessages, joinTyping, type TypingChannel } from '../../lib/realtime'
import type { UserRole } from '../../lib/permissions'

const T = {
  bg: '#0d0f12', bg2: '#131519', bg3: '#1a1d23', bg4: '#21252d',
  border: 'rgba(255,255,255,0.07)', border2: 'rgba(255,255,255,0.12)',
  text: '#e8eaf0', text2: '#8b90a0', text3: '#545968',
  blue: '#4f8ef7', teal: '#2dd4bf', green: '#34c77b', amber: '#f5a623', red: '#f04e4e', purple: '#a78bfa', accent: '#4f8ef7',
}
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '✅', '👀', '🙏', '🔥']

interface SSRUser { id: string; email: string; displayName: string | null; role: UserRole }
interface Conversation {
  id: string; type: 'channel' | 'dm' | 'group' | 'customer'; name: string | null; displayName: string | null
  topic: string | null; is_private: boolean; source: string | null; status: string
  last_message_at: string | null; isMember: boolean; muted: boolean; unread: number; memberIds: string[]; memberNames: string[]
}
interface Reaction { emoji: string; count: number; mine: boolean }
interface Message {
  id: string; conversation_id: string; sender_user_id: string | null; senderName: string; body: string
  message_type: string; created_at: string; edited_at?: string | null; deleted_at?: string | null
  attachments: { id?: string; storage_path: string; filename: string | null; content_type: string | null; size_bytes: number | null }[]
  mentions: string[]; reactions: Reaction[]; replyCount: number
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
  const [threadParent, setThreadParent] = useState<Message | null>(null)
  const [threadMessages, setThreadMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<any[] | null>(null)

  const activeIdRef = useRef<string | null>(null); activeIdRef.current = activeId
  const dirRef = useRef<DirUser[]>([]); dirRef.current = dir
  const conversationsRef = useRef<Conversation[]>([]); conversationsRef.current = conversations
  const threadParentRef = useRef<Message | null>(null); threadParentRef.current = threadParent
  // Message ids already applied to state (own sends + realtime echoes) so the
  // same insert is never double-counted.
  const seenMsgIds = useRef<Set<string>>(new Set())
  // Per-conversation message cache — switching back to a channel is instant.
  const msgCache = useRef<Record<string, Message[]>>({})
  const active = useMemo(() => conversations.find(c => c.id === activeId) || null, [conversations, activeId])

  // Deep-link: a notification (or push) opens /messages?c=<id> — select that
  // conversation once the list has loaded. Runs once.
  const deepLinkApplied = useRef(false)
  useEffect(() => {
    if (deepLinkApplied.current || activeId || conversations.length === 0) return
    if (typeof window === 'undefined') return
    const c = new URLSearchParams(window.location.search).get('c')
    if (c && conversations.some(cv => cv.id === c)) { deepLinkApplied.current = true; setActiveId(c) }
  }, [conversations, activeId])
  const totalUnread = useMemo(() => conversations.reduce((s, c) => s + (c.muted ? 0 : c.unread), 0), [conversations])
  useEffect(() => { onUnreadChange?.(totalUnread) }, [totalUnread, onUnreadChange])

  const markSeen = useCallback((id: string) => {
    seenMsgIds.current.add(id)
    if (seenMsgIds.current.size > 600) seenMsgIds.current = new Set(Array.from(seenMsgIds.current).slice(-300))
  }, [])
  const sortConvs = (cs: Conversation[]) => [...cs].sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || ''))

  // ── Loaders ───────────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    const r = await fetch('/api/conversations')
    if (r.ok) { const d = await r.json(); setConversations(d.conversations || []) }
    setLoadingConvs(false)
  }, [])
  // Single write-path for a conversation's messages: updates the cache, and the
  // visible list when that conversation is open.
  const setConvMessages = useCallback((conversationId: string, updater: (prev: Message[]) => Message[]) => {
    msgCache.current[conversationId] = updater(msgCache.current[conversationId] || [])
    if (activeIdRef.current === conversationId) setMessages(msgCache.current[conversationId])
  }, [])
  const loadMessages = useCallback(async (conversationId: string, opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoadingMsgs(true)
    const r = await fetch(`/api/messages?conversationId=${conversationId}`)
    if (r.ok) { const d = await r.json(); setConvMessages(conversationId, () => d.messages || []) }
    setLoadingMsgs(false)
  }, [setConvMessages])
  const loadThread = useCallback(async (conversationId: string, parentId: string) => {
    const r = await fetch(`/api/messages?conversationId=${conversationId}&parentId=${parentId}`)
    if (r.ok) { const d = await r.json(); setThreadMessages(d.messages || []) }
  }, [])
  const markRead = useCallback(async (conversationId: string) => {
    setConversations(cs => cs.map(c => c.id === conversationId ? { ...c, unread: 0 } : c))
    await fetch(`/api/conversations/${conversationId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read' }) }).catch(() => {})
  }, [])

  useEffect(() => { loadConversations(); fetch('/api/messages/directory').then(r => r.ok ? r.json() : { users: [] }).then(d => setDir(d.users || [])) }, [loadConversations])

  // Tab regained focus: reconcile quietly in case realtime events were missed
  // while asleep (incremental updates below otherwise never refetch).
  useEffect(() => {
    const onVis = () => {
      if (typeof document === 'undefined' || document.hidden) return
      loadConversations()
      if (activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [loadConversations, loadMessages])

  // ── Incremental realtime appliers (no refetch per event) ──────────
  const enrichRow = useCallback((row: any): Message => {
    const sender = row.sender_user_id === user.id
      ? { name: user.displayName || user.email }
      : dirRef.current.find(u => u.id === row.sender_user_id)
    return {
      ...row,
      senderName: row.sender_user_id ? (sender?.name || 'Unknown') : (row.message_type === 'external' ? 'Customer' : 'System'),
      attachments: [], mentions: [], reactions: [], replyCount: 0,
    }
  }, [user.id, user.displayName, user.email])

  // Realtime message rows don't carry attachments (separate table, inserted
  // just after) — reconcile with one cheap RLS-scoped lookup shortly after.
  const reconcileAttachments = useCallback((conversationId: string, messageId: string) => {
    setTimeout(async () => {
      try {
        const { data } = await getSupabase().from('message_attachments')
          .select('id, message_id, storage_path, filename, content_type, size_bytes').eq('message_id', messageId)
        if (!data?.length) return
        const apply = (m: Message) => m.id === messageId ? { ...m, attachments: data } : m
        setConvMessages(conversationId, ms => ms.map(apply))
        setThreadMessages(ms => ms.map(apply))
      } catch {}
    }, 700)
  }, [setConvMessages])

  const handleMessageInsert = useCallback((row: any) => {
    if (!row?.id || seenMsgIds.current.has(row.id)) return
    markSeen(row.id)
    const convId = row.conversation_id
    if (row.parent_message_id) {
      setConvMessages(convId, ms => ms.map(m => m.id === row.parent_message_id ? { ...m, replyCount: (m.replyCount || 0) + 1 } : m))
      const tp = threadParentRef.current
      if (tp && tp.id === row.parent_message_id) {
        const msg = enrichRow(row)
        setThreadMessages(ms => ms.some(m => m.id === row.id) ? ms : [...ms, msg])
      }
    } else {
      const msg = enrichRow(row)
      setConvMessages(convId, ms => ms.some(m => m.id === row.id) ? ms : [...ms, msg])
    }
    reconcileAttachments(convId, row.id)
    if (activeIdRef.current === convId && typeof document !== 'undefined' && !document.hidden && row.sender_user_id !== user.id) markRead(convId)
  }, [enrichRow, markSeen, markRead, reconcileAttachments, setConvMessages, user.id])

  const handleMessageUpdate = useCallback((row: any) => {
    if (!row?.id) return
    const apply = (m: Message) => m.id === row.id ? { ...m, body: row.body, edited_at: row.edited_at, deleted_at: row.deleted_at } : m
    setConvMessages(row.conversation_id, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp && tp.id === row.id ? apply(tp) : tp)
  }, [setConvMessages])

  // Idempotent reaction patch — safe against the realtime echo of our own
  // optimistic toggle (mine already set → skip).
  const handleReaction = useCallback((row: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => {
    if (!row?.message_id || !row.emoji || eventType === 'UPDATE') return
    const mineEvent = row.user_id === user.id
    const apply = (m: Message): Message => {
      if (m.id !== row.message_id) return m
      const rs = [...(m.reactions || [])]
      const i = rs.findIndex(r => r.emoji === row.emoji)
      if (eventType === 'INSERT') {
        if (i === -1) rs.push({ emoji: row.emoji, count: 1, mine: mineEvent })
        else {
          if (mineEvent && rs[i].mine) return m
          rs[i] = { ...rs[i], count: rs[i].count + 1, mine: rs[i].mine || mineEvent }
        }
      } else {
        if (i === -1) return m
        if (mineEvent && !rs[i].mine) return m
        const count = rs[i].count - 1
        if (count <= 0) rs.splice(i, 1)
        else rs[i] = { ...rs[i], count, mine: rs[i].mine && !mineEvent }
      }
      return { ...m, reactions: rs }
    }
    if (row.conversation_id) setConvMessages(row.conversation_id, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp ? apply(tp) : tp)
  }, [setConvMessages, user.id])

  // Live conversation-list updates — patch the list in place; only refetch for
  // events we can't apply locally (new conversation, my membership changed).
  // Previously ANY change here (including every message's last_message_at bump
  // and every user's read-marker) refetched the whole list for everyone.
  useEffect(() => {
    let t: any
    const scheduleReload = () => { clearTimeout(t); t = setTimeout(loadConversations, 400) }
    const off = subscribeToConversationList({
      onConversation: (row, type) => {
        if (!row?.id) return
        if (type === 'DELETE') { setConversations(cs => cs.filter(c => c.id !== row.id)); return }
        if (type === 'INSERT') { scheduleReload(); return }
        const existing = conversationsRef.current.find(c => c.id === row.id)
        if (!existing) { scheduleReload(); return }
        if (row.archived_at) { setConversations(cs => cs.filter(c => c.id !== row.id)); return }
        setConversations(cs => sortConvs(cs.map(c => c.id === row.id
          ? { ...c, name: row.name, topic: row.topic, is_private: row.is_private, status: row.status, last_message_at: row.last_message_at }
          : c)))
      },
      onParticipant: (row, type) => {
        if (!row?.conversation_id) return
        if (row.user_id === user.id) {
          if (type === 'UPDATE') {
            // My read/mute state changed (e.g. read in another tab) — patch.
            setConversations(cs => cs.map(c => c.id === row.conversation_id
              ? { ...c, muted: !!row.muted, unread: row.last_read_at && (!c.last_message_at || row.last_read_at >= c.last_message_at) ? 0 : c.unread }
              : c))
          } else scheduleReload() // joined/left a conversation
          return
        }
        // Someone else's read-state is irrelevant; membership changes patch
        // the member lists locally.
        if (type === 'UPDATE') return
        setConversations(cs => cs.map(c => {
          if (c.id !== row.conversation_id) return c
          const ids = type === 'INSERT'
            ? (c.memberIds.includes(row.user_id) ? c.memberIds : [...c.memberIds, row.user_id])
            : c.memberIds.filter(id => id !== row.user_id)
          return { ...c, memberIds: ids, memberNames: ids.map(id => dirRef.current.find(u => u.id === id)?.name).filter(Boolean) as string[] }
        }))
      },
    })
    return () => { clearTimeout(t); off() }
  }, [loadConversations, user.id])

  // Any incoming message (RLS-filtered): bump the sidebar unread/recency
  // locally, and desktop-notify while the tab is hidden.
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission() } catch {} }
    const off = subscribeToAllMessages((row) => {
      if (!row || row.sender_user_id === user.id) return
      if (typeof document !== 'undefined' && !document.hidden && row.conversation_id === activeIdRef.current) return
      setConversations(cs => {
        const i = cs.findIndex(c => c.id === row.conversation_id)
        if (i === -1) return cs // a new conversation — the conv INSERT event reloads the list
        const next = [...cs]
        next[i] = { ...next[i], unread: next[i].unread + 1, last_message_at: row.created_at }
        return sortConvs(next)
      })
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('New message', { body: String(row.body || '').slice(0, 120) || 'Attachment', tag: row.conversation_id }) } catch {}
      }
    })
    return () => off()
  }, [user.id])

  // Open a conversation: cached history shows instantly (refreshed quietly),
  // mark read, then live events patch state in place — no refetch per event.
  useEffect(() => {
    if (!activeId) return
    const cached = msgCache.current[activeId]
    if (cached) { setMessages(cached); loadMessages(activeId, { quiet: true }) }
    else { setMessages([]); loadMessages(activeId) }
    markRead(activeId)
    const off = subscribeToConversation(activeId, {
      onMessageInsert: handleMessageInsert,
      onMessageUpdate: handleMessageUpdate,
      onReaction: handleReaction,
    })
    return () => off()
  }, [activeId, loadMessages, markRead, handleMessageInsert, handleMessageUpdate, handleReaction])

  // Typing channel.
  const typingRef = useRef<TypingChannel | null>(null)
  useEffect(() => {
    setTypers([]); setThreadParent(null)
    if (!activeId) return
    const ch = joinTyping(activeId, { id: user.id, name: user.displayName || user.email }, setTypers)
    typingRef.current = ch
    return () => { ch.leave(); typingRef.current = null }
  }, [activeId, user.id, user.displayName, user.email])

  // Search (debounced).
  useEffect(() => {
    if (search.trim().length < 2) { setSearchResults(null); return }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/messages/search?q=${encodeURIComponent(search.trim())}`)
      if (r.ok) { const d = await r.json(); setSearchResults(d.results || []) }
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  // ── Actions (optimistic — patch local state, then call the API) ────
  // Patch a message everywhere it can be visible (timeline, thread, thread parent).
  const patchEverywhere = useCallback((conversationId: string | null, apply: (m: Message) => Message) => {
    if (conversationId) setConvMessages(conversationId, ms => ms.map(apply))
    setThreadMessages(ms => ms.map(apply))
    setThreadParent(tp => tp ? apply(tp) : tp)
  }, [setConvMessages])

  const sendMessage = useCallback(async (body: string, mentionIds: string[], attachments: any[], parentMessageId?: string) => {
    const convId = activeIdRef.current
    if (!convId) return
    const r = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: convId, body, mentionIds, attachments, parentMessageId }) })
    if (r.ok) {
      const d = await r.json()
      if (!d.message) return
      markSeen(d.message.id)
      // API echoes attachments in camelCase — normalise for rendering.
      const msg: Message = {
        ...d.message, reactions: [], replyCount: 0, mentions: d.message.mentions || [],
        attachments: (d.message.attachments || []).map((a: any) => ({ storage_path: a.storagePath, filename: a.filename, content_type: a.contentType, size_bytes: a.sizeBytes })),
      }
      if (parentMessageId) {
        setThreadMessages(ms => ms.some(x => x.id === msg.id) ? ms : [...ms, msg])
        setConvMessages(convId, ms => ms.map(m => m.id === parentMessageId ? { ...m, replyCount: (m.replyCount || 0) + 1 } : m))
      } else {
        setConvMessages(convId, ms => ms.some(x => x.id === msg.id) ? ms : [...ms, msg])
      }
    } else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not send') }
  }, [markSeen, setConvMessages])

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    patchEverywhere(activeIdRef.current, (m) => {
      if (m.id !== messageId) return m
      const rs = [...(m.reactions || [])]
      const i = rs.findIndex(r => r.emoji === emoji)
      if (i === -1) rs.push({ emoji, count: 1, mine: true })
      else if (rs[i].mine) { const c = rs[i].count - 1; if (c <= 0) rs.splice(i, 1); else rs[i] = { ...rs[i], count: c, mine: false } }
      else rs[i] = { ...rs[i], count: rs[i].count + 1, mine: true }
      return { ...m, reactions: rs }
    })
    const r = await fetch(`/api/messages/${messageId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const editMessage = useCallback(async (messageId: string, body: string) => {
    patchEverywhere(activeIdRef.current, (m) => m.id === messageId ? { ...m, body, edited_at: new Date().toISOString() } : m)
    const r = await fetch(`/api/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const deleteMessage = useCallback(async (messageId: string) => {
    if (!confirm('Delete this message?')) return
    patchEverywhere(activeIdRef.current, (m) => m.id === messageId ? { ...m, body: '', deleted_at: new Date().toISOString() } : m)
    const r = await fetch(`/api/messages/${messageId}`, { method: 'DELETE' }).catch(() => null)
    if (!r?.ok && activeIdRef.current) loadMessages(activeIdRef.current, { quiet: true })
  }, [patchEverywhere, loadMessages])

  const openThread = useCallback((m: Message) => { setThreadParent(m); if (activeId) loadThread(activeId, m.id) }, [activeId, loadThread])

  const createConversation = useCallback(async (payload: any) => {
    const r = await fetch('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    if (r.ok) { const d = await r.json(); await loadConversations(); setActiveId(d.conversationId); setModal(null) }
    else { const d = await r.json().catch(() => ({})); alert(d.error || 'Could not create') }
  }, [loadConversations])

  const channels = conversations.filter(c => c.type === 'channel' || c.type === 'group')
  const dms = conversations.filter(c => c.type === 'dm')
  const inbox = conversations.filter(c => c.type === 'customer')
  const nameById = useMemo(() => Object.fromEntries(dir.map(u => [u.id, u.name])), [dir])

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: T.bg }}>
      {/* Sidebar */}
      <div style={{ width: 270, flexShrink: 0, background: T.bg2, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 14px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Messages</span>
            {totalUnread > 0 && <span style={{ fontSize: 11, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '1px 7px' }}>{totalUnread}</span>}
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages…"
            style={{ width: '100%', padding: '6px 9px', background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {searchResults !== null ? (
            <div style={{ padding: '4px 0' }}>
              <div style={{ padding: '4px 16px', fontSize: 10, color: T.text3, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{searchResults.length} result{searchResults.length === 1 ? '' : 's'}</div>
              {searchResults.map(r => (
                <button key={r.id} onClick={() => { setActiveId(r.conversationId); setSearch(''); setSearchResults(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 16px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                  <div style={{ fontSize: 11, color: T.text3 }}>{r.conversationName} · {r.senderName}</div>
                  <div style={{ fontSize: 12, color: T.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.body}</div>
                </button>
              ))}
            </div>
          ) : loadingConvs ? <div style={{ padding: 20, color: T.text3, fontSize: 12 }}>Loading…</div> : (
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

      {/* Thread/main */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!active ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 13 }}>Select a conversation, or start a new one.</div>
          ) : (
            <>
              <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 8 }}>
                <span style={{ color: T.text3 }}>{convGlyph(active)}</span>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{convTitle(active)}</span>
                {active.topic && <span style={{ fontSize: 12, color: T.text3, marginLeft: 8, borderLeft: `1px solid ${T.border}`, paddingLeft: 8 }}>{active.topic}</span>}
                {active.type !== 'dm' && <span style={{ marginLeft: 'auto', fontSize: 11, color: T.text3 }}>{active.memberIds.length} member{active.memberIds.length === 1 ? '' : 's'}</span>}
              </div>
              <MessageList messages={messages} loading={loadingMsgs} meId={user.id} nameById={nameById}
                onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} onOpenThread={openThread} />
              {typers.length > 0 && <div style={{ padding: '2px 18px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{typers.map(t => t.name).join(', ')} {typers.length === 1 ? 'is' : 'are'} typing…</div>}
              <Composer key={active.id} dir={dir.filter(u => u.id !== user.id)} onSend={(b, m, a) => sendMessage(b, m, a)} onTyping={() => typingRef.current?.setTyping(true)} placeholder={`Message ${convTitle(active)}`} />
            </>
          )}
        </div>

        {/* Thread panel */}
        {threadParent && active && (
          <div style={{ width: 380, flexShrink: 0, borderLeft: `1px solid ${T.border}`, background: T.bg2, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 52, flexShrink: 0, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', padding: '0 14px', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Thread</span>
              <button onClick={() => setThreadParent(null)} style={{ background: 'none', border: 'none', color: T.text2, fontSize: 18, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <MessageRow m={threadParent} mine={threadParent.sender_user_id === user.id} meId={user.id} nameById={nameById} onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} compact />
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, fontSize: 10, color: T.text3 }}>{threadMessages.length} repl{threadMessages.length === 1 ? 'y' : 'ies'}</div>
              {threadMessages.map(m => <MessageRow key={m.id} m={m} mine={m.sender_user_id === user.id} meId={user.id} nameById={nameById} onReact={toggleReaction} onEdit={editMessage} onDelete={deleteMessage} compact />)}
            </div>
            <Composer key={'thread-' + threadParent.id} dir={dir.filter(u => u.id !== user.id)} onSend={(b, m, a) => sendMessage(b, m, a, threadParent.id)} onTyping={() => {}} placeholder="Reply…" />
          </div>
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
function Hint({ children }: { children: React.ReactNode }) { return <div style={{ padding: '4px 16px', fontSize: 11, color: T.text3, fontStyle: 'italic' }}>{children}</div> }
function convGlyph(c: Conversation) { return c.type === 'dm' ? '@' : c.type === 'customer' ? '☎' : c.is_private || c.type === 'group' ? '🔒' : '#' }
function convTitle(c: Conversation) { return c.displayName || c.name || (c.type === 'dm' ? 'Direct message' : 'Untitled') }
function ConvRow({ c, active, onClick }: { c: Conversation; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', background: active ? 'rgba(79,142,247,0.12)' : 'transparent', color: active ? T.text : (c.unread ? T.text : T.text2) }}>
      <span style={{ color: T.text3, width: 12, textAlign: 'center', fontSize: 12 }}>{convGlyph(c)}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: c.unread ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{convTitle(c)}</span>
      {c.unread > 0 && <span style={{ fontSize: 10, fontFamily: 'monospace', background: T.red, color: '#fff', borderRadius: 10, padding: '0 6px' }}>{c.unread}</span>}
    </button>
  )
}

// ── Message list + row ───────────────────────────────────────────────
interface RowActions {
  onReact: (id: string, emoji: string) => void
  onEdit: (id: string, body: string) => void
  onDelete: (id: string) => void
  onOpenThread?: (m: Message) => void
}
function MessageList({ messages, loading, meId, nameById, onReact, onEdit, onDelete, onOpenThread }: { messages: Message[]; loading: boolean; meId: string; nameById: Record<string, string> } & RowActions) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [messages])
  if (loading) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text3, fontSize: 12 }}>Loading messages…</div>
  return (
    <div ref={ref} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {messages.length === 0 && <div style={{ color: T.text3, fontSize: 12, textAlign: 'center', marginTop: 30 }}>No messages yet — say hello.</div>}
      {messages.map(m => <MessageRow key={m.id} m={m} mine={m.sender_user_id === meId} meId={meId} nameById={nameById} onReact={onReact} onEdit={onEdit} onDelete={onDelete} onOpenThread={onOpenThread} />)}
    </div>
  )
}

function MessageRow({ m, mine, meId, nameById, onReact, onEdit, onDelete, onOpenThread, compact }: { m: Message; mine: boolean; meId: string; nameById: Record<string, string>; compact?: boolean } & RowActions) {
  const [hover, setHover] = useState(false)
  const [picker, setPicker] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.body)
  useEffect(() => { setDraft(m.body) }, [m.body])
  const deleted = !!m.deleted_at

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPicker(false) }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', position: 'relative' }}>
      <div style={{ fontSize: 10, color: T.text3, marginBottom: 3 }}>
        <span style={{ color: mine ? T.blue : T.teal, fontWeight: 600 }}>{mine ? 'You' : m.senderName}</span>
        <span style={{ marginLeft: 6 }}>{new Date(m.created_at).toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
        {m.edited_at && !deleted && <span style={{ marginLeft: 6, fontStyle: 'italic' }}>(edited)</span>}
      </div>

      <div style={{ position: 'relative', maxWidth: compact ? '100%' : '70%' }}>
        {/* Hover toolbar */}
        {hover && !deleted && !editing && (
          <div style={{ position: 'absolute', top: -14, [mine ? 'left' : 'right']: 0, display: 'flex', gap: 2, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 6, padding: 2, zIndex: 3 } as any}>
            <IconBtn title="React" onClick={() => setPicker(p => !p)}>🙂</IconBtn>
            {onOpenThread && <IconBtn title="Reply in thread" onClick={() => onOpenThread(m)}>↳</IconBtn>}
            {mine && <IconBtn title="Edit" onClick={() => setEditing(true)}>✎</IconBtn>}
            {mine && <IconBtn title="Delete" onClick={() => onDelete(m.id)}>🗑</IconBtn>}
          </div>
        )}
        {picker && (
          <div style={{ position: 'absolute', top: -40, [mine ? 'left' : 'right']: 0, display: 'flex', gap: 2, background: T.bg4, border: `1px solid ${T.border2}`, borderRadius: 8, padding: 4, zIndex: 4 } as any}>
            {QUICK_EMOJI.map(e => <button key={e} onClick={() => { onReact(m.id, e); setPicker(false) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, padding: 2 }}>{e}</button>)}
          </div>
        )}

        <div style={{ background: mine ? 'rgba(79,142,247,0.16)' : T.bg3, border: `1px solid ${mine ? 'rgba(79,142,247,0.3)' : T.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 13, lineHeight: 1.5, color: T.text, wordBreak: 'break-word' }}>
          {deleted ? <span style={{ color: T.text3, fontStyle: 'italic' }}>message deleted</span> : editing ? (
            <div>
              <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={2} style={{ width: 260, background: T.bg2, border: `1px solid ${T.border2}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: 'inherit', padding: 6 }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button onClick={() => { onEdit(m.id, draft.trim()); setEditing(false) }} style={miniBtn(T.blue, true)}>Save</button>
                <button onClick={() => { setEditing(false); setDraft(m.body) }} style={miniBtn(T.text3)}>Cancel</button>
              </div>
            </div>
          ) : <span dangerouslySetInnerHTML={{ __html: mdToHtml(m.body, nameById) }} />}
          {m.attachments?.map((a, i) => <AttachmentView key={a.id || i} att={a} />)}
        </div>

        {/* Reactions */}
        {m.reactions?.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {m.reactions.map(r => (
              <button key={r.emoji} onClick={() => onReact(m.id, r.emoji)} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, padding: '1px 7px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: r.mine ? 'rgba(79,142,247,0.18)' : T.bg3, border: `1px solid ${r.mine ? T.blue : T.border}`, color: T.text2 }}>
                <span>{r.emoji}</span><span style={{ fontFamily: 'monospace' }}>{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Thread affordance */}
        {!compact && onOpenThread && m.replyCount > 0 && (
          <button onClick={() => onOpenThread(m)} style={{ marginTop: 4, background: 'none', border: 'none', color: T.blue, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
            ↳ {m.replyCount} repl{m.replyCount === 1 ? 'y' : 'ies'}
          </button>
        )}
      </div>
    </div>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button title={title} onClick={onClick} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: '2px 5px', color: T.text2 }}>{children}</button>
}
function miniBtn(color: string, solid?: boolean): React.CSSProperties { return { padding: '3px 10px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit', fontWeight: 600, cursor: 'pointer', border: 'none', background: solid ? color : 'transparent', color: solid ? '#fff' : color } }

// Markdown-ish → HTML (escaped). Handles links, **bold**, *italic*, `code`, @mention.
function mdToHtml(text: string, nameById: Record<string, string>): string {
  let s = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer" style="color:#4f8ef7">$1</a>')
  s = s.replace(/`([^`]+)`/g, '<code style="background:#21252d;padding:1px 4px;border-radius:3px;font-family:monospace">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
  const names = Object.values(nameById)
  if (names.length) {
    const alt = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')
    s = s.replace(new RegExp(`@(${alt})`, 'g'), '<span style="color:#4f8ef7;background:rgba(79,142,247,0.12);border-radius:3px;padding:0 2px">@$1</span>')
  }
  return s.replace(/\n/g, '<br/>')
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
function Composer({ dir, onSend, onTyping, placeholder }: { dir: DirUser[]; onSend: (body: string, mentionIds: string[], attachments: any[]) => Promise<void> | void; onTyping: () => void; placeholder?: string }) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [mentionPick, setMentionPick] = useState<{ query: string } | null>(null)
  const [picked, setPicked] = useState<DirUser[]>([])
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const lastTyping = useRef(0)

  function onChange(v: string) {
    setText(v)
    const now = Date.now(); if (now - lastTyping.current > 1500) { lastTyping.current = now; onTyping() }
    const m = v.match(/@([\w' .-]*)$/)
    setMentionPick(m ? { query: m[1].toLowerCase() } : null)
  }
  function pickMention(u: DirUser) {
    setText(t => t.replace(/@([\w' .-]*)$/, `@${u.name} `))
    setPicked(p => p.some(x => x.id === u.id) ? p : [...p, u]); setMentionPick(null); taRef.current?.focus()
  }
  async function doSend() {
    const body = text.trim()
    if ((!body && files.length === 0) || busy) return
    setBusy(true)
    try {
      const sb = getSupabase()
      const attachments: any[] = []
      for (const f of files) {
        const path = `${crypto.randomUUID()}-${f.name.replace(/[^\w.-]/g, '_')}`
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
          {matches.map(u => <div key={u.id} onMouseDown={e => { e.preventDefault(); pickMention(u) }} style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', color: T.text }}>@{u.name}</div>)}
        </div>
      )}
      {files.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {files.map((f, i) => <span key={i} style={{ fontSize: 11, background: T.bg3, border: `1px solid ${T.border}`, borderRadius: 6, padding: '3px 8px', color: T.text2 }}>📎 {f.name} <button onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer' }}>×</button></span>)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <label style={{ cursor: 'pointer', color: T.text3, fontSize: 18, padding: '6px 4px' }} title="Attach files">
          📎<input type="file" multiple style={{ display: 'none' }} onChange={e => { setFiles(fs => [...fs, ...Array.from(e.target.files || [])]); e.target.value = '' }} />
        </label>
        <textarea ref={taRef} value={text} onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() } }}
          placeholder={placeholder || 'Write a message…'} rows={1}
          style={{ flex: 1, resize: 'none', maxHeight: 140, background: T.bg3, border: `1px solid ${T.border2}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: 'inherit', padding: '9px 12px', outline: 'none', lineHeight: 1.5 }} />
        <button onClick={doSend} disabled={busy} style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: busy ? T.bg4 : T.blue, color: busy ? T.text3 : '#fff', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit' }}>{busy ? '…' : 'Send'}</button>
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

// pages/api/chat-sessions/[id].ts
// GET    — fetch a session's metadata + all messages in order
// PATCH  — rename a session (body: { title })
// DELETE — delete a session (cascades to all messages)

import type { NextApiRequest, NextApiResponse } from 'next'
import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
}

async function handler(req: NextApiRequest, res: NextApiResponse, user: any) {
  const sessionId = req.query.id as string
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Session ID required' })
  }

  const sb = getAdmin()

  // Verify user owns this session before doing anything
  const { data: session, error: sErr } = await sb
    .from('chat_sessions')
    .select('id, title, user_id, created_at, updated_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (sErr) return res.status(500).json({ error: sErr.message })
  if (!session) return res.status(404).json({ error: 'Session not found' })
  if (session.user_id !== user.id) return res.status(403).json({ error: 'Forbidden' })

  if (req.method === 'GET') {
    const { data: messages, error: mErr } = await sb
      .from('chat_messages')
      .select('id, role, content, context_page, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
    if (mErr) return res.status(500).json({ error: mErr.message })
    return res.status(200).json({ session, messages: messages || [] })
  }

  if (req.method === 'PATCH') {
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim().slice(0, 100)
      : null
    if (!title) return res.status(400).json({ error: 'Valid title required' })
    const { data, error } = await sb
      .from('chat_sessions')
      .update({ title })
      .eq('id', sessionId)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ session: data })
  }

  if (req.method === 'DELETE') {
    const { error } = await sb
      .from('chat_sessions')
      .delete()
      .eq('id', sessionId)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ deleted: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(null, handler)

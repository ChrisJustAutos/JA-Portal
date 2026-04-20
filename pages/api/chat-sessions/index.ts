// pages/api/chat-sessions/index.ts
// GET  — list current user's chat sessions (most recent first)
// POST — create a new empty chat session

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
  const sb = getAdmin()

  if (req.method === 'GET') {
    // Limit to 30 most recent sessions — older ones are rarely needed
    const { data, error } = await sb
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(30)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ sessions: data || [] })
  }

  if (req.method === 'POST') {
    const title = typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim().slice(0, 100)
      : 'New conversation'
    const { data, error } = await sb
      .from('chat_sessions')
      .insert({ user_id: user.id, title })
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ session: data })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

export default withAuth(null, handler)

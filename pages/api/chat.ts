import type { NextApiRequest, NextApiResponse } from 'next'
import { isAuthenticated } from '../../lib/auth'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorised' }); return }
  if (req.method !== 'POST') { res.status(405).end(); return }

  const { messages, context } = req.body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array required and must not be empty' }); return
  }

  // Filter out any empty messages
  const validMessages = messages.filter((m: any) => m.content && m.content.trim && m.content.trim().length > 0)
  if (validMessages.length === 0) {
    res.status(400).json({ error: 'No valid messages' }); return
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: context || 'You are the Just Autos management assistant with access to live MYOB data for both JAWS and VPS. Be concise and helpful.',
        messages: validMessages,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Anthropic API error:', response.status, err.substring(0,200))
      res.status(response.status).json({ error: `AI service error: ${response.status}` }); return
    }

    const data = await response.json()
    const reply = data.content?.find((b: any) => b.type === 'text')?.text || 'Sorry, I could not generate a response.'
    res.status(200).json({ reply })
  } catch (err: any) {
    console.error('Chat error:', err.message)
    res.status(500).json({ error: 'Chat failed — please try again' })
  }
}

import type { NextApiRequest, NextApiResponse } from 'next'
import { isAuthenticated } from '../../lib/auth'

export const config = { maxDuration: 30 }

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorised' }); return }
  if (req.method !== 'POST') { res.status(405).end(); return }

  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set')
    res.status(500).json({ reply: 'Chat is not configured — missing API key.' }); return
  }

  const { messages, context } = req.body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ reply: 'No messages provided.' }); return
  }

  // Filter out any empty messages and the initial assistant greeting
  const validMessages = messages.filter((m: any) =>
    m.content && typeof m.content === 'string' && m.content.trim().length > 0
  )
  if (validMessages.length === 0) {
    res.status(400).json({ reply: 'No valid messages.' }); return
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
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: context || 'You are the Just Autos management assistant with access to live MYOB data for both JAWS and VPS. Be concise and helpful. Use Australian dollar formatting.',
        messages: validMessages,
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error('Anthropic API error:', response.status, errText.substring(0, 300))
      // Return the error as a chat reply so the user can see what's wrong
      res.status(200).json({ reply: `AI error (${response.status}): ${errText.substring(0, 100)}` }); return
    }

    const data = await response.json()
    const reply = data.content?.find((b: any) => b.type === 'text')?.text || 'Sorry, I could not generate a response.'
    res.status(200).json({ reply })
  } catch (err: any) {
    console.error('Chat error:', err.message)
    // Return error details as chat reply so we can debug
    res.status(200).json({ reply: `Connection error: ${err.message}` })
  }
}

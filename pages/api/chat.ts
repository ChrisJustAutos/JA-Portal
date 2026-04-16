import type { NextApiRequest, NextApiResponse } from 'next'
import { isAuthenticated } from '../../lib/auth'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) { res.status(401).json({ error: 'Unauthorised' }); return }
  if (req.method !== 'POST') { res.status(405).end(); return }
  const { messages, context } = req.body
  if (!messages || !Array.isArray(messages)) { res.status(400).json({ error: 'messages required' }); return }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: context || 'You are the Just Autos management assistant.', messages }),
    })
    if (!response.ok) { const err = await response.text(); res.status(response.status).json({ error: err }); return }
    const data = await response.json()
    const reply = data.content?.find((b: any) => b.type === 'text')?.text || ''
    res.status(200).json({ reply })
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Chat failed' })
  }
}

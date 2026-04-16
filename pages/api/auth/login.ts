import type { NextApiRequest, NextApiResponse } from 'next'

const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || 'justautos2026'

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const { password } = req.body

  if (password === PORTAL_PASSWORD) {
    const value = Buffer.from(PORTAL_PASSWORD).toString('base64')
    const isProd = process.env.NODE_ENV === 'production'
    res.setHeader('Set-Cookie', 
      `ja_portal_auth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${isProd ? '; Secure' : ''}`
    )
    return res.status(200).json({ ok: true })
  }

  return res.status(401).json({ error: 'Incorrect password' })
}

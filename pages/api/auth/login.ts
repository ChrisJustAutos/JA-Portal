import type { NextApiRequest, NextApiResponse } from 'next'
import { setAuthCookie } from '../../../lib/auth'
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || 'justautos2026'
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return }
  const { password } = req.body
  if (password === PORTAL_PASSWORD) { setAuthCookie(res); res.status(200).json({ ok: true }); return }
  res.status(401).json({ error: 'Incorrect password' })
}

import type { NextApiRequest, NextApiResponse } from 'next'
import { clearAuthCookie } from '../../../lib/auth'
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  clearAuthCookie(res); res.status(200).json({ ok: true })
}

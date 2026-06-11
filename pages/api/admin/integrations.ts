// pages/api/admin/integrations.ts
// Self-service integration credentials (Settings → Connections → Integrations).
//   GET   — every managed key: where its effective value comes from (db/env),
//           a masked preview for secrets, the full value for non-secrets.
//   PATCH — { values: { KEY: 'value' | '' } } — '' deletes the DB row
//           (falling back to env); anything else upserts. Admin only.
//   POST  — { action: 'test_sms', to } | { action: 'test_email', to } —
//           sends a real test through the configured creds.

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import {
  INTEGRATION_KEYS, integrationSources, invalidateIntegrationCache,
} from '../../../lib/integration-config'
import { sendSms } from '../../../lib/clicksend'
import { sendMail } from '../../../lib/email'

export const config = { maxDuration: 30 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

export default withAuth(null, async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const db = sb()

  if (req.method === 'GET') {
    const sources = await integrationSources()
    return res.status(200).json({ fields: sources })
  }

  if (req.method === 'PATCH') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    const values = body.values && typeof body.values === 'object' ? body.values : {}
    const known = new Set<string>(INTEGRATION_KEYS as readonly string[])
    let changed = 0
    for (const [key, raw] of Object.entries(values)) {
      if (!known.has(key)) continue
      const value = String(raw ?? '').trim()
      if (!value) {
        await db.from('integration_settings').delete().eq('key', key)
      } else {
        await db.from('integration_settings').upsert({ key, value, updated_by: user.id, updated_at: new Date().toISOString() })
      }
      changed++
    }
    if (!changed) return res.status(400).json({ error: 'No recognised keys in values' })
    invalidateIntegrationCache()
    const sources = await integrationSources()
    return res.status(200).json({ ok: true, fields: sources })
  }

  if (req.method === 'POST') {
    let body: any = {}
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
    catch { return res.status(400).json({ error: 'Bad JSON body' }) }
    invalidateIntegrationCache()

    if (body.action === 'test_sms') {
      const to = String(body.to || '').trim()
      if (!to) return res.status(400).json({ error: 'to (mobile number) required' })
      const r = await sendSms(to, `JA Portal test SMS — ClickSend is connected ✓ (${new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' })})`)
      return res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, messageId: r.messageId } : { ok: false, error: r.error })
    }

    if (body.action === 'test_email') {
      const to = String(body.to || '').trim()
      if (!to || !to.includes('@')) return res.status(400).json({ error: 'to (email address) required' })
      try {
        await sendMail('noreply@mail.justautos.app', {
          to: [to],
          subject: 'JA Portal test email — mail-out system connected ✓',
          html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">This is a test from the JA Portal Integrations page.<br><br>If you're reading this, outbound email is working.<br><span style="color:#888">${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}</span></div>`,
        })
        return res.status(200).json({ ok: true })
      } catch (e: any) { return res.status(502).json({ ok: false, error: e?.message || 'send failed' }) }
    }

    if (body.action === 'regen_intake_token') {
      const crypto = await import('crypto')
      const token = crypto.randomBytes(24).toString('base64url')
      await db.from('integration_settings').upsert({ key: 'CRM_INTAKE_TOKEN', value: token, updated_by: user.id, updated_at: new Date().toISOString() })
      invalidateIntegrationCache()
      return res.status(200).json({ ok: true, token })
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  res.setHeader('Allow', 'GET, PATCH, POST')
  return res.status(405).json({ error: 'GET, PATCH or POST only' })
})

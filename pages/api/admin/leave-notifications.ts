// pages/api/admin/leave-notifications.ts
// Settings → Leave Notifications. Backs the staff directory the leave-approval
// emailer resolves addresses through (lib/leave-decision-emails), plus the send
// log so HR can see who was told what.
//
//   GET    → { settings, directory, log, counts }
//   PATCH  → { settings: { hr_email?, enabled? } }  (integration_settings)
//   POST   → { action: 'save_entry', id?, match_name, email, note? }
//          | { action: 'delete_entry', id }
//          | { action: 'run_now' }        run the emailer immediately
//          | { action: 'dry_run' }        resolve only — sends nothing
//
// Admin only (admin:settings).

import { createClient } from '@supabase/supabase-js'
import { withAuth } from '../../../lib/authServer'
import { roleHasPermission } from '../../../lib/permissions'
import { getIntegrations, invalidateIntegrationCache } from '../../../lib/integration-config'
import { normaliseName, runLeaveDecisionEmails } from '../../../lib/leave-decision-emails'

export const config = { maxDuration: 60 }

function sb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export default withAuth(null, async (req, res, user) => {
  if (!roleHasPermission(user.role, 'admin:settings')) return res.status(403).json({ error: 'Admin only' })
  const db = sb()

  if (req.method === 'GET') {
    const cfg = await getIntegrations(['LEAVE_HR_EMAIL', 'LEAVE_EMAILS_ENABLED'])
    const [dir, log] = await Promise.all([
      db.from('leave_staff_directory').select('id, match_name, match_key, email, note, updated_at').order('match_name'),
      db.from('leave_decision_emails')
        .select('id, monday_item_id, decision, applicant_name, email_to, email_source, status, error, leave_start, leave_end, classification, total_days, attempts, sent_at, created_at')
        .order('created_at', { ascending: false }).limit(100),
    ])
    if (dir.error) return res.status(500).json({ error: dir.error.message })
    if (log.error) return res.status(500).json({ error: log.error.message })
    const rows = log.data || []
    return res.status(200).json({
      settings: {
        hr_email: cfg.LEAVE_HR_EMAIL || 'ryan@justautosmechanical.com.au',
        enabled: String(cfg.LEAVE_EMAILS_ENABLED || 'true').toLowerCase() !== 'false',
      },
      directory: dir.data || [],
      log: rows,
      counts: {
        sent: rows.filter(r => r.status === 'sent').length,
        no_address: rows.filter(r => r.status === 'no_address').length,
        failed: rows.filter(r => r.status === 'failed').length,
        baseline: rows.filter(r => r.status === 'baseline').length,
      },
    })
  }

  let body: any = {}
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Bad JSON body' }) }

  if (req.method === 'PATCH') {
    const s = body.settings && typeof body.settings === 'object' ? body.settings : {}
    const writes: Array<{ key: string; value: string }> = []
    if (s.hr_email !== undefined) {
      const email = String(s.hr_email || '').trim()
      if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That HR email address doesn\'t look valid' })
      writes.push({ key: 'LEAVE_HR_EMAIL', value: email })
    }
    if (s.enabled !== undefined) writes.push({ key: 'LEAVE_EMAILS_ENABLED', value: s.enabled ? 'true' : 'false' })
    for (const w of writes) {
      if (!w.value) {
        await db.from('integration_settings').delete().eq('key', w.key)
      } else {
        const { error } = await db.from('integration_settings')
          .upsert({ key: w.key, value: w.value, updated_by: user.id, updated_at: new Date().toISOString() })
        if (error) return res.status(500).json({ error: error.message })
      }
    }
    invalidateIntegrationCache()
    return res.status(200).json({ ok: true, changed: writes.length })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const action = String(body.action || '')

  if (action === 'save_entry') {
    const matchName = String(body.match_name || '').trim()
    const email = String(body.email || '').trim()
    const note = String(body.note || '').trim() || null
    if (!matchName) return res.status(400).json({ error: 'Name is required — type it exactly as it appears on the board' })
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email address doesn\'t look valid' })
    const matchKey = normaliseName(matchName)
    if (!matchKey) return res.status(400).json({ error: 'That name has no letters or numbers in it' })

    // match_key is unique — an edit that collides with another row is a rename
    // onto an existing entry, which the operator almost certainly didn't mean.
    const { data: clash } = await db.from('leave_staff_directory').select('id, match_name').eq('match_key', matchKey).maybeSingle()
    if (clash && (!body.id || clash.id !== body.id)) {
      return res.status(409).json({ error: `"${clash.match_name}" already covers that name — edit that entry instead` })
    }

    const row = { match_name: matchName, match_key: matchKey, email, note, updated_at: new Date().toISOString() }
    if (body.id) {
      const { error } = await db.from('leave_staff_directory').update(row).eq('id', String(body.id))
      if (error) return res.status(500).json({ error: error.message })
    } else {
      const { error } = await db.from('leave_staff_directory').insert(row)
      if (error) return res.status(500).json({ error: error.message })
    }
    return res.status(200).json({ ok: true })
  }

  if (action === 'delete_entry') {
    if (!body.id) return res.status(400).json({ error: 'id required' })
    const { error } = await db.from('leave_staff_directory').delete().eq('id', String(body.id))
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (action === 'run_now' || action === 'dry_run') {
    if (!process.env.MONDAY_API_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })
    try {
      const r = await runLeaveDecisionEmails({ dryRun: action === 'dry_run' })
      return res.status(200).json({ ok: true, result: r })
    } catch (e: any) {
      return res.status(500).json({ error: (e?.message || String(e)).slice(0, 400) })
    }
  }

  return res.status(400).json({ error: `Unknown action "${action}"` })
})

// lib/b2b-slack.ts
// SERVER-ONLY. One place for B2B order Slack notifications. Posts to BOTH:
//   1. #jaws-orders (private channel C0BNBTQMQ9L, Chris 2026-08-06) via the
//      Portal Assistant bot — the bot must be /invite'd into the channel.
//   2. The legacy b2b_settings.slack_new_order_webhook_url, when configured
//      ("as well", not instead — Chris).
// Both destinations are best-effort: a Slack outage must never break the
// order pipeline or the drop-ship watcher.

import type { SupabaseClient } from '@supabase/supabase-js'
import { postMessage } from './slack-bot/slack'

const ORDERS_CHANNEL = process.env.B2B_ORDERS_SLACK_CHANNEL || 'C0BNBTQMQ9L'   // #jaws-orders

export async function postB2bOrderSlack(c: SupabaseClient, text: string): Promise<void> {
  // Bot → #jaws-orders
  try {
    await postMessage({ channel: ORDERS_CHANNEL, text })
  } catch (e: any) {
    console.error('b2b-slack: #jaws-orders post failed:', e?.message || e)
  }
  // Legacy webhook (channel-bound where it was created)
  try {
    const { data: settings } = await c.from('b2b_settings').select('slack_new_order_webhook_url').eq('id', 'singleton').maybeSingle()
    if (settings?.slack_new_order_webhook_url) {
      await fetch(settings.slack_new_order_webhook_url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
    }
  } catch (e: any) {
    console.error('b2b-slack: webhook post failed:', e?.message || e)
  }
}
